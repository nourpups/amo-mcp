#!/usr/bin/env python3
"""Emit actual HTTP status samples without URLs, response bodies or credentials."""
import argparse
import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request

p=argparse.ArgumentParser()
p.add_argument('--log-file', required=True)
p.add_argument('--endpoint', action='append', required=True, help='nonsecret-label=https://public-health-endpoint')
a=p.parse_args()
endpoints=[v.split('=',1) for v in a.endpoint]
def probe(item):
    name,url=item
    try:
        with urllib.request.urlopen(url,timeout=5) as r: status=r.status
    except urllib.error.HTTPError as e: status=e.code
    except Exception: status=None
    return {'service':name,'time':time.time(),'status':status}
fd=os.open(a.log_file,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
with os.fdopen(fd,'a',buffering=1) as log, concurrent.futures.ThreadPoolExecutor(max_workers=len(endpoints)) as pool:
    while True:
        start=time.monotonic()
        for sample in pool.map(probe,endpoints):log.write(json.dumps(sample)+'\n')
        time.sleep(max(0.1,3-(time.monotonic()-start)))
