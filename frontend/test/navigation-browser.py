"""Check the shared navigation against a running IntraCampus UI."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--origin', required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--channel', default='chrome')
args = parser.parse_args()
origin = args.origin.rstrip('/')
args.output.mkdir(parents=True, exist_ok=False)
widths = [320, 390, 576, 577, 600, 640, 692, 768, 832, 1280, 1440]
routes = ['/', '/student', '/student/canteen', '/student/library', '/pos', '/staff/canteen', '/staff/library']
checks, failures, errors = [], [], []
with sync_playwright() as p:
    browser = p.chromium.launch(channel=args.channel, headless=True)
    try:
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.on('pageerror', lambda error: errors.append(str(error)))
        for route in routes:
            page.goto(origin + route, wait_until='networkidle')
            nav = page.get_by_role('navigation', name='Điều hướng chính', exact=True)
            expect(nav.get_by_role('link')).to_have_count(7)
            for width in widths:
                page.set_viewport_size({'width': width, 'height': 844 if width < 800 else 900})
                layout = nav.evaluate('''nav => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth,
                  active: [...nav.querySelectorAll('a[aria-current="page"]')].map(a => a.getAttribute('href')),
                  links: [...nav.querySelectorAll('a')].map(a => {
                    const r = a.getBoundingClientRect(), label = a.querySelector('span')?.getBoundingClientRect();
                    return { href: a.getAttribute('href'), text: a.textContent, left: r.left, right: r.right,
                      top: r.top, bottom: r.bottom, labelLeft: label?.left, labelRight: label?.right };
                  }) })''')
                issues = []
                if layout['scroll'] > width:
                    issues.append('horizontal overflow')
                if layout['active'] != [route]:
                    issues.append('active navigation mismatch')
                for link in layout['links']:
                    if link['left'] < 0 or link['right'] > width + 1 or link['bottom'] <= link['top']:
                        issues.append('link outside viewport: ' + link['href'])
                    if link['labelLeft'] < 0 or link['labelRight'] > width + 1:
                        issues.append('label outside viewport: ' + link['href'])
                    expect(nav.get_by_role('link', name=link['text'], exact=True)).to_be_visible()
                item = {'route': route, 'width': width, 'issues': issues, **layout}
                checks.append(item)
                if issues:
                    failures.append(item)
                if width in [390, 600, 1440]:
                    page.screenshot(path=str(args.output / f'{route.strip("/").replace("/", "-") or "home"}-{width}.png'), full_page=True)
            page.set_viewport_size({'width': 640, 'height': 900})
            nav.get_by_role('link').first.focus()
            page.keyboard.press('Tab')
            assert page.evaluate('document.activeElement.getAttribute("href")') == '/student'
            assert page.evaluate('getComputedStyle(document.activeElement).outlineStyle') != 'none'
            destination = '/' if route == '/student' else '/student'
            nav.locator(f'a[href="{destination}"]').click()
            page.wait_for_url(origin + destination)
            page.go_back(wait_until='networkidle')
            assert urlparse(page.url).path == route
    finally:
        browser.close()
        (args.output / 'report.json').write_text(json.dumps({'routes': routes, 'widths': widths, 'checks': checks,
            'failures': failures, 'pageErrors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
assert not failures, f'{len(failures)} responsive checks failed; see report.json'
assert not errors, errors
print(f'PASS {len(checks)} navigation layouts, keyboard, active state and Back')
