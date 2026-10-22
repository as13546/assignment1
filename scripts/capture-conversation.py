from playwright.sync_api import sync_playwright
import urllib.request
import sys

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5177'
out = sys.argv[2] if len(sys.argv) > 2 else '.shots/conversation.png'
theme = sys.argv[3] if len(sys.argv) > 3 else 'light'

urllib.request.urlopen(
    urllib.request.Request(f'{url}/api/sessions/revoke', method='POST'), timeout=5
).read()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    page = browser.new_context(
        viewport={'width': 1600, 'height': 1000}, color_scheme=theme
    ).new_page()
    page.goto(url, wait_until='networkidle')
    page.click('#grant-sessions')
    page.wait_for_selector('.session-item', timeout=30000)
    # Open the first conversation and let it stream in.
    page.locator('.session-item').first.click()
    page.wait_for_timeout(9000)
    page.screenshot(path=out.replace('.png', '-chat.png'), full_page=False)
    page.click('#view-flow')
    page.wait_for_timeout(900)
    page.screenshot(path=out.replace('.png', '-flow.png'), full_page=False)
    browser.close()
    print('saved', out.replace('.png', '-chat.png'), 'and', out.replace('.png', '-flow.png'))
