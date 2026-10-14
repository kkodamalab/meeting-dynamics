"""Local browser integration. Simulated microphone does not verify physical phones."""
import json, math, struct, wave
from playwright.sync_api import sync_playwright
with wave.open('/tmp/meeting-smoke.wav','wb') as f:
    f.setnchannels(1); f.setsampwidth(2); f.setframerate(48000)
    f.writeframes(b''.join(struct.pack('<h',int(23000*math.sin(2*math.pi*440*i/48000))) for i in range(48000*3)))
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture=/tmp/meeting-smoke.wav'])
    host_context=browser.new_context(viewport={"width":1400,"height":1600}); host=host_context.new_page(); errors=[]
    host.set_default_timeout(8000)
    host.on('pageerror',lambda e:errors.append(str(e)))
    host.goto('http://127.0.0.1:5173/')
    assert host.get_by_text('会議の声を、').count()==0
    host.get_by_label('話者数',exact=True).select_option('2')
    host.get_by_placeholder('https://meeting-dynamics-relay.…workers.dev').fill('http://127.0.0.1:8787')
    host.get_by_role('button',name='セッションを作成',exact=True).click()
    host.get_by_role('heading',name='参加者を登録',exact=True).wait_for()
    assert host.locator('.single-qr img').count()==1
    host.get_by_role('button',name='次の参加者',exact=True).click()
    assert host.locator('.single-qr select').input_value()=='2'
    host.get_by_role('button',name='一括登録',exact=True).click()
    assert host.locator('.qr img').count()==2
    links=host.locator('.qr a').evaluate_all('(nodes)=>nodes.map(n=>n.href)')
    assert len(set(links))==2
    clients=[]
    for i,link in enumerate(links):
        ctx=browser.new_context(permissions=['microphone']);page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(link);page.get_by_placeholder('例：Aさん').fill(f'Phone {i+1}')
        page.get_by_role('button',name='マイクを許可',exact=True).click()
        page.get_by_text('マイク OK',exact=True).wait_for()
        page.get_by_role('button',name='参加登録を完了',exact=True).click()
        clients.append((ctx,page))
    host.get_by_text('Phone 1',exact=True).first.wait_for()
    host.get_by_text('Phone 2',exact=True).first.wait_for()
    host.get_by_role('button',name='座席配置へ進む',exact=True).click()
    shape=host.locator('.table-shape').bounding_box();assert abs(shape['width']-shape['height'])<1
    host.get_by_role('button',name='長方形',exact=True).click()
    shape=host.locator('.table-shape').bounding_box();assert abs(shape['width']-shape['height'])<1
    icon=host.get_by_label('Phone 1 の座席').bounding_box()
    host.mouse.move(icon['x']+20,icon['y']+20);host.mouse.down();host.mouse.move(icon['x']+50,icon['y']+40);host.mouse.up()
    new=host.get_by_label('Phone 1 の座席').bounding_box();assert new['x']>icon['x']+20
    shape=host.locator('.table-shape').bounding_box()
    host.mouse.move(shape['x']+30,shape['y']+30);host.mouse.down();host.mouse.move(shape['x']+45,shape['y']+40);host.mouse.up()
    moved=host.locator('.table-shape').bounding_box();assert moved['x']>shape['x']+10
    handle=host.get_by_label('図形を変形').bounding_box()
    host.mouse.move(handle['x']+10,handle['y']+10);host.mouse.down();host.mouse.move(handle['x']+50,handle['y']+20);host.mouse.up()
    resized=host.locator('.table-shape').bounding_box();assert resized['width']>moved['width']+30
    host.get_by_role('button',name='配置を保存',exact=True).click()
    saved=host.evaluate("JSON.parse(localStorage.getItem('meeting-layout-2-rect'))")
    assert saved['geometry']['width']!=saved['geometry']['height']
    host.get_by_role('button',name='計測画面へ進む',exact=True).click()
    host.get_by_role('button',name='計測開始',exact=True).click()
    host.wait_for_function("document.querySelector('.timer').textContent !== '0:00'")
    host.get_by_role('button',name='計測終了',exact=True).click()
    with host.expect_download() as d:host.get_by_role('button',name='JSON をダウンロード',exact=True).click()
    rows=json.load(open(d.value.path()));assert len(rows)==2 and sum(r['speakingSeconds'] for r in rows)==0 and rows[0]['unknownSeconds']>0
    with host.expect_download() as d:host.get_by_role('button',name='CSV をダウンロード',exact=True).click()
    assert 'Phone 1' in open(d.value.path()).read()
    clients[0][0].close()
    host.get_by_role('button',name='Meeting Dynamics').click()
    host.get_by_role('button',name='前のセッションを再開').click()
    host.get_by_role('button',name='座席配置へ進む').click()
    assert host.evaluate("JSON.parse(localStorage.getItem('meeting-layout-2-rect'))")==saved
    assert not errors,errors
    print('PASS: two isolated participant contexts, real WebSocket relay, single/bulk QR, registration/mic synchronization, square geometry, seat/table drag, resize, save, VAD totals and CSV/JSON. Microphones simulated; physical devices unverified.')
    browser.close()
