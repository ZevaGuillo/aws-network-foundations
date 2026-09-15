#!/usr/bin/env python3
"""
Module 1's application, Python.

It exists to be reached, not to be useful. Every route here answers a question the
infrastructure asks, and nothing else.

Run it locally before deploying anything:

    PORT=9001 TIER=backend python3 lib/app/server.py
    PORT=9000 TIER=frontend BACKEND_URL=http://localhost:9001 python3 lib/app/server.py

That is the whole reason this is a real file rather than a string inside the CDK app: a syntax
error found in a terminal costs a second, and the same error found through an instance that
boots cleanly in a private subnet and serves nothing costs an afternoon.

Standard library only. See docs/adr/0026-the-application-contract.md.
"""

import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Every interface, never the loopback address.
#
# The health check does not originate on this instance. It arrives from the load balancer's
# network interface, across the subnet. Bound to loopback, this process answers a local curl
# perfectly while every probe fails and every target is marked unhealthy - and no log anywhere
# names a bind address. See docs/adr/0026-the-application-contract.md.
BIND_ADDRESS = '0.0.0.0'

DEEP_PROBE_TIMEOUT_SECONDS = 2


def required(name):
    """Fail loudly rather than guessing, in the manner of lib/environment.py's guard."""
    value = os.environ.get(name)
    if not value:
        sys.exit(
            f'{name} is not set. The systemd unit written by user data supplies it; '
            f'see docs/adr/0027-user-data-terminates-systemd-owns-the-process.md.'
        )
    return value


# Deliberately no default. The port lives in PORTS in the CDK and travels here through the
# systemd unit, so there is exactly one place it can be wrong.
PORT = int(required('PORT'))
TIER = required('TIER')

# Frontend only. Its absence is what makes this process a backend.
BACKEND_URL = os.environ.get('BACKEND_URL')

HOSTNAME = socket.gethostname()


def probe_backend():
    """
    Cross the chain layers 2 and 3 built, and report how long it took.

    This is not a health check and no target group may ever point at it. The backend's health is
    already measured, per target, by its own target group behind the internal balancer. What this
    adds is the part that measurement cannot cover: this tier's egress, the layer 2 rule
    permitting it into the internal balancer, that balancer's listener, and DNS resolution inside
    the VPC.

    It returns a duration rather than a boolean because the interesting answer is a number.

    See docs/adr/0029-the-deep-check-is-a-reachability-probe.md.
    """
    started = time.monotonic()
    try:
        with urllib.request.urlopen(
            f'{BACKEND_URL}/health', timeout=DEEP_PROBE_TIMEOUT_SECONDS
        ) as response:
            body = response.read().decode('utf-8')
            reached = True
            detail = json.loads(body)
    except (urllib.error.URLError, OSError, ValueError) as error:
        reached = False
        detail = str(error)

    return {
        'reached': reached,
        'through': BACKEND_URL,
        'elapsed_ms': round((time.monotonic() - started) * 1000, 1),
        'backend': detail,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def respond(self, status, payload):
        body = json.dumps(payload, indent=2).encode('utf-8') + b'\n'
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - the name is BaseHTTPRequestHandler's, not ours
        if self.path == '/health':
            # Shallow, and that is the decision rather than the easy option. Nothing downstream
            # is touched. See docs/adr/0019-shallow-health-check-at-the-balancer.md.
            self.respond(200, {'status': 'ok', 'tier': TIER, 'host': HOSTNAME})

        elif self.path == '/health/deep':
            if BACKEND_URL is None:
                self.respond(
                    501,
                    {
                        'status': 'not applicable',
                        'tier': TIER,
                        'reason': 'this tier has no downstream dependency to reach',
                    },
                )
            else:
                self.respond(200, {'status': 'probed', 'tier': TIER, 'probe': probe_backend()})

        elif self.path == '/':
            self.respond(
                200,
                {
                    'tier': TIER,
                    'host': HOSTNAME,
                    'runtime': 'python',
                    'routes': ['/health', '/health/deep'],
                },
            )

        else:
            self.respond(404, {'status': 'no such route', 'path': self.path})

    def log_message(self, fmt, *args):
        # One line per request on stdout, which systemd captures into the journal. The default
        # writes to stderr with a timestamp the journal would add again.
        sys.stdout.write('%s %s\n' % (self.address_string(), fmt % args))


if __name__ == '__main__':
    ThreadingHTTPServer((BIND_ADDRESS, PORT), Handler).serve_forever()
