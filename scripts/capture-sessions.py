from playwright.sync_api import sync_playwright
import urllib.request
import sys

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173'
out = sys.argv[2] if len(sys.argv) > 2 else '.shots/sessions.png'
theme = sys.argv[3] if len(sys.argv) > 3 else 'light'

with sync_playwright() as p:
    # Ensure permission is not granted, so the request UI shows.
    try:
        req = urllib.request.Request(f'{url}/api/sessions/revoke', method='POST')
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print('revoke failed:', e)
    browser = p.chromium.launch(headless=True, channel='chrome')
    context = browser.new_context(
        viewport={'width': 1440, 'height': 900},
        color_scheme=theme,
    )
    page = context.new_page()
    page.goto(url, wait_until='networkidle')
    page.wait_for_timeout(600)
    # Empty state screenshot first
    page.screenshot(path=out.replace('.png', '-empty.png'), full_page=False)
    # Switch to Sessions tab
    page.click('#grant-sessions')
    page.wait_for_timeout(400)
    page.wait_for_timeout(600)
    page.screenshot(path=out.replace('.png', '-list.png'), full_page=False)
    browser.close()
    print(f'saved {out} variants')
