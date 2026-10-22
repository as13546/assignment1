from playwright.sync_api import sync_playwright
import sys

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/?replay=subagent.jsonl'
out = sys.argv[2] if len(sys.argv) > 2 else '.shots/workflow-light.png'
theme = sys.argv[3] if len(sys.argv) > 3 else 'light'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    context = browser.new_context(
        viewport={'width': 1440, 'height': 900},
        color_scheme=theme,
    )
    page = context.new_page()
    page.goto(url, wait_until='networkidle')
    # Let the replay stream in and settle (444 events at the default delay).
    page.wait_for_timeout(20000)
    page.click('#view-flow')
    page.wait_for_timeout(600)
    page.screenshot(path=out, full_page=False)
    browser.close()
    print(f'saved {out}')
