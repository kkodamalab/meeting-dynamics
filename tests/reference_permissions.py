"""Browser lifecycle checks; permission refusal/device removal are deliberately simulated."""
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
 ctx=b.new_context(permissions=['microphone']);ctx.add_init_script("""window.__calls=0;window.__deny=true;const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async(c)=>{window.__calls++;if(window.__deny)throw new DOMException('Permission denied','NotAllowedError');window.__stream=await original(c);return window.__stream};""")
 page=ctx.new_page();page.goto('http://127.0.0.1:5173/');assert page.get_by_label('話者識別方式').input_value()=='smartphone';assert page.evaluate('window.__calls')==0
 page.get_by_label('話者識別方式').select_option('reference');page.get_by_label('話者数',exact=True).select_option('2');page.get_by_placeholder('https://meeting-dynamics-relay.…workers.dev').fill('http://127.0.0.1:8787');page.get_by_role('button',name='セッションを作成',exact=True).click()
 page.get_by_role('button',name='PCマイクを開始／再取得').click();page.get_by_role('alert').filter(has_text='Permission denied').wait_for();assert page.evaluate('window.__calls')==1
 page.get_by_role('button',name='明示的にSMARTPHONE ONLYへ切替').click();assert page.get_by_role('button',name='PCマイクを開始／再取得').count()==0
 page.get_by_role('button',name='Meeting Dynamics').click();page.get_by_label('話者識別方式').select_option('reference');page.get_by_role('button',name='セッションを作成',exact=True).click();page.evaluate('window.__deny=false')
 page.get_by_role('button',name='PCマイクを開始／再取得').click();page.get_by_role('button',name='PCマイクを停止').wait_for();page.wait_for_timeout(400)
 assert page.get_by_label('PC入力デバイス').is_disabled()
 page.evaluate("window.__stream.getAudioTracks()[0].dispatchEvent(new Event('ended'))")
 page.get_by_role('alert').filter(has_text='切断').wait_for();page.get_by_role('button',name='PCマイクを開始／再取得').click();page.get_by_role('button',name='PCマイクを停止').wait_for()
 page.get_by_role('button',name='PCマイクを停止').click();assert not page.get_by_label('PC入力デバイス').is_disabled()
 page.reload();page.get_by_role('button',name='前のセッションを再開').click();page.evaluate('window.__deny=false');page.get_by_role('button',name='PCマイクを開始／再取得').click();page.get_by_role('button',name='PCマイクを停止').wait_for();page.get_by_text('取得・受信正常',exact=False).wait_for()
 print('PASS: A requests no PC permission; B refusal and explicit A fallback; permission grant, ended-track disconnect, device-choice unlock, recovery and host reload sequence restart. Simulated permission/device events, not hardware verification.')
 b.close()
