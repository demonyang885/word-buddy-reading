#!/usr/bin/env python3
import http.server
import ssl

HOST = "0.0.0.0"
PORT = 8443
CERT = ".cert/cert.pem"
KEY = ".cert/key.pem"

server = http.server.ThreadingHTTPServer((HOST, PORT), http.server.SimpleHTTPRequestHandler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(CERT, KEY)
server.socket = ctx.wrap_socket(server.socket, server_side=True)
print(f"Serving HTTPS on https://{HOST}:{PORT}")
try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\nStopped")
finally:
    server.server_close()
