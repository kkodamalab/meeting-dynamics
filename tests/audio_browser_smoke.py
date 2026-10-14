"""Two actual browser microphone pipelines with deterministic WAV inputs, not physical phones."""
import json,math,struct,wave
from playwright.sync_api import sync_playwright
for label,gain in [('old',1800),('new',18000)]:
 with wave.open(f'/tmp/meeting-{label}.wav','wb') as f:
  f.setnchannels(1);f.setsampwidth(2);f.setframerate(48000)
  f.writeframes(b''.join(struct.pack('<h',int(gain*math.sin(2*math.pi*440*i/48000)) if i>=48000*3 and (label=='old' or i<48000*6.5) else 0) for i in range(48000*20)))
with sync_playwright() as p:
 host_browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 host=host_browser.new_page(viewport={'width':1400,'height':1600});errors=[];host.on('pageerror',lambda e:errors.append(str(e)))
 host.goto('http://127.0.0.1:5173/');host.get_by_label('話者数',exact=True).select_option('2')
 host.get_by_placeholder('https://meeting-dynamics-relay.…workers.dev').fill('http://127.0.0.1:8787')
 host.get_by_role('button',name='セッションを作成',exact=True).click()
 host.get_by_role('button',name='一括登録',exact=True).click()
 links=host.locator('.qr a').evaluate_all('(nodes)=>nodes.map(n=>n.href)');clients=[]
 for label,link in zip(['old','new'],links):
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',f'--use-file-for-fake-audio-capture=/tmp/meeting-{label}.wav'])
  ctx=browser.new_context(permissions=['microphone']);page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(link);page.get_by_placeholder('例：Aさん').fill(label);clients.append((browser,page))
 for _,page in clients:
  page.get_by_role('button',name='マイクを許可',exact=True).click()
  page.get_by_role('button',name='静音を測定（3秒）',exact=True).click()
 for _,page in clients:page.get_by_role('button',name='本人の発話を測定（3秒）',exact=True).click()
 for _,page in clients:
  page.get_by_text('補正設定済み',exact=True).wait_for()
  page.get_by_role('button',name='参加登録を完了',exact=True).click()
 host.get_by_text('登録済み',exact=True).first.wait_for()
 host.get_by_role('button',name='座席配置へ進む').click()
 host.get_by_role('button',name='計測画面へ進む').click()
 assert not host.locator('.audio-diagnostics').evaluate('(e)=>e.open')
 assert host.locator('.dashboard > .card').count()==2
 host.get_by_text('音声診断',exact=True).click()
 host.get_by_role('button',name='計測開始',exact=True).click()
 host.wait_for_function("document.querySelector('.timer').textContent==='0:03'")
 host.get_by_role('button',name='計測終了',exact=True).click()
 with host.expect_download() as d:host.get_by_role('button',name='JSON をダウンロード').click()
 rows=json.load(open(d.value.path()))
 assert rows[0]['name']=='old' and rows[0]['speakingSeconds']>0,rows
 assert rows[1]['speakingSeconds']==0,rows
 assert all('unknownSeconds' in r and 'confidence' in r for r in rows)
 assert not errors,errors
 print('PASS: separate old/new browser microphone pipelines, 10x gain difference, real quiet/speech calibration UI, adaptive low-gain VAD, collapsed diagnostics preserving two panels, old speech attribution/new silent and extended JSON export. Generated audio only; no physical-device accuracy claim.')
 for browser,_ in clients:browser.close()
 host_browser.close()
