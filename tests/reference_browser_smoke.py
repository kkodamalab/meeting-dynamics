"""PC + two independent browser microphone pipelines. Generated audio; no phone accuracy claim."""
import json,math,struct,wave
from playwright.sync_api import sync_playwright
for channel in ['pc','A','B']:
 with wave.open('/tmp/meeting-reference-'+channel+'.wav','wb') as f:
  f.setnchannels(1);f.setsampwidth(2);f.setframerate(48000)
  frames=[]
  for i in range(48000*24):
   t=i/48000;speaker=None if t<5.5 else 'A' if t<9.5 else 'B' if t<15.5 else 'A'
   amplitude=20 if speaker is None else 7000 if channel=='pc' else 13000 if channel==speaker else 2500
   frames.append(struct.pack('<h',int(amplitude*math.sin(2*math.pi*440*t))))
  f.writeframes(b''.join(frames))
with sync_playwright() as p:
 args=lambda k:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',f'--use-file-for-fake-audio-capture=/tmp/meeting-reference-{k}.wav']
 hb=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=args('pc'));hc=hb.new_context(permissions=['microphone'],viewport={'width':1400,'height':1600});host=hc.new_page();errors=[];host.on('pageerror',lambda e:errors.append(str(e)))
 host.goto('http://127.0.0.1:5173/');assert host.get_by_label('話者識別方式').input_value()=='smartphone'
 host.get_by_label('話者数',exact=True).select_option('2');host.get_by_label('話者識別方式').select_option('reference');host.get_by_placeholder('https://meeting-dynamics-relay.…workers.dev').fill('http://127.0.0.1:8787');host.get_by_role('button',name='セッションを作成',exact=True).click()
 host.get_by_role('button',name='一括登録',exact=True).click();links=host.locator('.qr a').evaluate_all('(nodes)=>nodes.map(n=>n.href)');clients=[]
 for key,link in zip(['A','B'],links):
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=args(key));ctx=browser.new_context(permissions=['microphone']);page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(link);page.get_by_placeholder('例：Aさん').fill(key);clients.append((browser,page))
 for _,page in clients:
  page.get_by_role('button',name='マイクを許可',exact=True).click();page.get_by_role('button',name='参加登録を完了',exact=True).click()
 host.get_by_role('button',name='PCマイクを開始／再取得').click();host.get_by_role('button',name='PCマイクを停止').wait_for()
 host.get_by_text('共同キャリブレーション',exact=True).click()
 host.get_by_role('button',name='STEP 1 全員無言（3秒）').click()
 host.get_by_role('button',name='STEP 2 Aのみ発話（5秒）',exact=True).click()
 host.get_by_role('button',name='STEP 3 Bのみ発話（5秒）',exact=True).click()
 host.get_by_text('全マイクの応答ベクトル測定完了',exact=True).wait_for(timeout=20000)
 host.get_by_role('button',name='座席配置へ進む').click()
 marker=host.get_by_label('PC MIC位置');assert marker.count()==1
 marker.scroll_into_view_if_needed();box=marker.bounding_box();host.mouse.move(box['x']+15,box['y']+10);host.mouse.down();host.mouse.move(box['x']+50,box['y']+25);host.mouse.up();host.get_by_role('button',name='配置を保存',exact=True).click()
 assert host.evaluate("JSON.parse(localStorage.getItem('meeting-layout-2-circle')).pcPosition.x")>50
 host.get_by_role('button',name='計測画面へ進む').click();assert host.locator('.dashboard > .card').count()==2
 host.get_by_text('音声診断',exact=True).click();assert host.locator('.audio-diagnostics tbody tr').count()==3
 host.get_by_role('button',name='計測開始',exact=True).click();host.wait_for_function("document.querySelector('.timer').textContent==='0:03'")
 host.get_by_role('button',name='計測終了',exact=True).click()
 host.get_by_text('研究用詳細・A/B比較・評価テスト',exact=True).click()
 with host.expect_download() as d:host.get_by_role('button',name='研究データJSON（時系列・校正・評価）').click()
 data=json.load(open(d.value.path()));assert len(data['participants'])==2
 assert data['study']['mode']=='reference' and data['study']['ready'] and len(data['study']['profiles'])==2
 assert data['study']['layout']['pcPosition']['x']>50
 assert len(data['study']['windows'])>=20 and 'pc' in data['study']['windows'][0]['features']
 assert all(key in data['study'] for key in ['intervals','evaluation'])
 assert 'hostKey' not in json.dumps(data)
 with host.expect_download() as d:host.get_by_role('button',name='特徴量CSV').click()
 assert 'metadata' in open(d.value.path()).read()
 assert not errors,errors
 print('PASS: PC + 2 smartphone microphone feature pipelines, shared 3s/5s/5s calibration, draggable/saved PC position, 3-mic diagnostics, 2-panel UI, synchronized A/B study and full JSON/CSV export. Synthetic audio only.')
 for browser,_ in clients:browser.close()
 hb.close()
