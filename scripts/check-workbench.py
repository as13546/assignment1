from playwright.sync_api import sync_playwright
import urllib.request
import sys

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5174'

# Start from a known state: no permission granted on the server yet.
urllib.request.urlopen(
    urllib.request.Request(f'{url}/api/sessions/revoke', method='POST'), timeout=5
).read()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    page = browser.new_context(viewport={'width': 1440, 'height': 900}).new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)

    page.goto(url, wait_until='networkidle')
    page.wait_for_timeout(800)

    # 1. The permission ask is up before anything is read.
    ask_visible = page.locator('#grant-sessions').is_visible()
    print('permission ask shown:', ask_visible)

    # 2. Grant, then open the first conversation in the list.
    page.click('#grant-sessions')
    # Reading the transcripts off disk is not instant, so wait for the list.
    page.wait_for_selector('.session-item', timeout=30000)
    print('stop-sharing offered:', page.locator('#revoke-sessions').is_visible())
    items = page.locator('.session-item')
    print('conversations listed:', items.count())
    items.first.click()
    page.wait_for_timeout(3000)
    turns = page.locator('#trajectory .turn').count()
    tools = page.locator('#trajectory .tool').count()
    print('stage turns:', turns, '| tool calls rendered:', tools)
    print('open conversation highlighted:', page.locator('.session-item[data-open="true"]').count() == 1)

    # 3. The workflow view draws the same run.
    page.click('#view-flow')
    page.wait_for_timeout(700)
    print('workflow steps:', page.locator('.wf-step').count())
    print('stage stats:', (page.locator('#stage-stats').inner_text() or '(empty)').strip())

    # 4. Taking the permission back must stop the server from reading.
    page.click('#revoke-sessions')
    page.wait_for_timeout(600)
    print('ask shown again:', page.locator('#grant-sessions').is_visible())
    status = page.evaluate("fetch('/api/sessions').then(r => r.status)")
    print('GET /api/sessions after revoke:', status)

    print('js errors:', errors or 'none')
    browser.close()
