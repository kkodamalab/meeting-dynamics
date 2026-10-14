"""Shared calibration UI regression with generated signals and Chromium stereo capture.
No real PC/phone acoustic accuracy assertion.
"""
import json, time, wave, struct
from playwright.sync_api import sync_playwright
with wave.open('/tmp/meeting-calibration-stereo.wav', 'wb') as wav:
    wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(48000)
    wav.writeframes(struct.pack('<hh', 10, 10) * 48000)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=[
        '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
        '--use-file-for-fake-audio-capture=/tmp/meeting-calibration-stereo.wav'])
    errors = []
    def page():
        context = browser.new_context(permissions=['microphone'], viewport={'width':1400,'height':1600})
        context.add_init_script("""
            window.__rms=.001;
            const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia=(c)=>capture({...c,audio:{...c.audio,channelCount:{ideal:2}}});
            const make=AudioContext.prototype.createAnalyser;
            AudioContext.prototype.createAnalyser=function(){const a=make.call(this);
                a.getFloatTimeDomainData=b=>{for(let i=0;i<b.length;i++)b[i]=Math.SQRT2*window.__rms*Math.sin(2*Math.PI*i/64)};
                return a;};
        """)
        page = context.new_page(); page.set_default_timeout(10000)
        page.on('pageerror', lambda e: errors.append(str(e)))
        return page
    host=page();host.goto('http://127.0.0.1:5173/')
    host.get_by_label('話者数',exact=True).select_option('2')
    host.get_by_label('話者識別方式').select_option('reference')
    host.get_by_placeholder('https://meeting-dynamics-relay.…workers.dev').fill('http://127.0.0.1:8787')
    host.get_by_role('button',name='セッションを作成',exact=True).click()
    host.get_by_role('button',name='一括登録',exact=True).click()
    links=host.locator('.qr a').evaluate_all('(nodes)=>nodes.map(n=>n.href)')
    phones=[]
    for name,link in zip(['A','B'],links):
        phone=page();phone.goto(link);phone.get_by_placeholder('例：Aさん').fill(name)
        phone.get_by_role('button',name='マイクを許可',exact=True).click()
        phone.get_by_role('button',name='参加登録を完了',exact=True).click();phones.append(phone)
    host.get_by_role('button',name='PCマイクを開始／再取得').click()
    host.get_by_role('button',name='PCマイクを停止').wait_for()
    host.get_by_text('共同キャリブレーション',exact=True).click()
    def until(predicate):
        end=time.monotonic()+15
        while time.monotonic()<end:
            if predicate():return
            host.wait_for_timeout(50)
        raise AssertionError('Shared calibration condition timed out')
    def signal(values):
        for device,rms in zip([phones[0],phones[1],host],values):device.evaluate('(rms)=>window.__rms=rms',rms)
        host.wait_for_timeout(300)
    step1=host.get_by_role('button',name='STEP 1 全員無言（3秒）')
    step2=host.get_by_role('button',name='STEP 2 Aのみ発話（5秒）',exact=True)
    step3=host.get_by_role('button',name='STEP 3 Bのみ発話（5秒）',exact=True)
    signal([.001,0,.001]);step1.click()
    until(lambda:host.get_by_role('alert').count()==1)
    assert host.get_by_text('全サンプルが完全なゼロ: マイク入力・消音を確認',exact=True).count()==1
    assert host.get_by_role('alert').count()==1 and not step2.is_enabled() and not step3.is_enabled()
    assert host.locator('.calibration-quality tbody tr').count()==3
    assert 'SNR不足' not in host.get_by_role('alert').inner_text()
    signal([.001,.001,.001]);step1.click();until(lambda:step2.is_enabled())
    assert step3.is_enabled() and host.get_by_role('alert').count()==0
    assert host.get_by_text('対象外（無音測定）',exact=True).count()==3
    signal([.06,.09,.03]);step2.click()
    until(lambda:host.get_by_role('button',name='STEP 2 Aのみ発話（5秒） ✓',exact=True).count()==1)
    signal([.009,.6,.001]);step3.click();until(lambda:host.get_by_role('alert').count()==1)
    assert '発話SNR' in host.locator('.calibration-quality').last.inner_text()
    assert host.get_by_role('button',name='STEP 2 Aのみ発話（5秒） ✓',exact=True).is_enabled()
    signal([.009,.6,.03]);step3.click()
    host.get_by_text('全マイクの応答ベクトル測定完了',exact=True).wait_for(timeout=15000)
    assert host.get_by_role('alert').count()==0
    host.get_by_text('研究用詳細・A/B比較・評価テスト',exact=True).click()
    with host.expect_download() as d:host.get_by_role('button',name='研究データJSON（時系列・校正・評価）').click()
    data=json.load(open(d.value.path()));quality=data['study']['calibrationResults']['0']['quality']
    assert quality['pc']['settings']['channelCount']==2, quality['pc']['settings']
    for name in ['autoGainControl','echoCancellation','noiseSuppression']:assert quality['pc']['settings'][name] is False
    assert data['study']['ready'] and all(row['passed'] for row in quality.values())
    with host.expect_download() as d:host.get_by_role('button',name='特徴量CSV').click()
    assert 'calibrationResults' in open(d.value.path()).read()
    assert not errors, errors
    print('PASS: STEP 1 failure -> targeted retry -> STEP 2 success -> STEP 3 SNR failure -> retry success; per-device diagnostics, single error, full JSON/CSV, actual Chromium fake-capture stereo 48kHz and AGC/EC/NS OFF. Generated waveforms; physical devices unverified.')
    browser.close()
