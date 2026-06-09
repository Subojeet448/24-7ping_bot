from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.error
import json
import time
import ssl

class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        target_url = params.get('url', [None])[0]

        if not target_url:
            self._write({'error': 'No URL provided', 'ok': False})
            return

        # Normalize URL
        target_url = target_url.strip()
        if not target_url.startswith(('http://', 'https://')):
            target_url = 'https://' + target_url

        # Validate URL structure
        try:
            p = urlparse(target_url)
            if not p.netloc:
                self._write({'error': 'Invalid URL', 'ok': False, 'url': target_url})
                return
        except Exception:
            self._write({'error': 'URL parse failed', 'ok': False, 'url': target_url})
            return

        result = self._ping_with_retry(target_url)
        self._write(result)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _write(self, data):
        try:
            self.wfile.write(json.dumps(data).encode())
        except Exception:
            pass  # Client disconnected

    def _ping_with_retry(self, url, retries=2):
        """
        2 retries with 1s gap.
        Returns the last result (success immediately, or last failure).
        """
        last_result = None
        for attempt in range(retries + 1):
            result = self._ping(url)
            last_result = result
            if result.get('ok'):
                return result  # Success — no need to retry
            if attempt < retries:
                time.sleep(1)  # Wait before retry
        last_result['retried'] = retries
        return last_result

    def _ping(self, url):
        start = time.time()
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

        try:
            req = urllib.request.Request(
                url,
                headers={
                    'User-Agent': 'Mozilla/5.0 (compatible; PingBot/3.0; Uptime-Monitor)',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Connection': 'close',
                },
                method='GET'
            )
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                ms = round((time.time() - start) * 1000)
                status_code = resp.getcode()
                return {
                    'url': url,
                    'status': 'up',
                    'status_code': status_code,
                    'ms': ms,
                    'ok': True
                }

        except urllib.error.HTTPError as e:
            ms = round((time.time() - start) * 1000)
            # 2xx/3xx = up, 4xx = up (site reachable), 5xx = down
            ok = e.code < 500
            return {
                'url': url,
                'status': 'up' if ok else 'down',
                'status_code': e.code,
                'ms': ms,
                'ok': ok,
                'error': None if ok else f'Server error {e.code}'
            }

        except urllib.error.URLError as e:
            ms = round((time.time() - start) * 1000)
            reason = str(e.reason) if e.reason else 'URLError'
            # Friendly error messages
            if 'timed out' in reason.lower():
                friendly = 'Connection timed out'
            elif 'name or service not known' in reason.lower() or 'nodename nor servname' in reason.lower():
                friendly = 'DNS resolution failed'
            elif 'connection refused' in reason.lower():
                friendly = 'Connection refused'
            elif 'ssl' in reason.lower():
                friendly = 'SSL/TLS error'
            else:
                friendly = reason[:80]
            return {
                'url': url,
                'status': 'down',
                'status_code': 0,
                'ms': ms,
                'ok': False,
                'error': friendly
            }

        except TimeoutError:
            ms = round((time.time() - start) * 1000)
            return {
                'url': url,
                'status': 'down',
                'status_code': 0,
                'ms': ms,
                'ok': False,
                'error': 'Connection timed out'
            }

        except Exception as e:
            ms = round((time.time() - start) * 1000)
            return {
                'url': url,
                'status': 'down',
                'status_code': 0,
                'ms': ms,
                'ok': False,
                'error': str(e)[:100]
            }

    def log_message(self, format, *args):
        pass  # Suppress logs
