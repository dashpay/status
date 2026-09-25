"""Refuse overwrite and distinguish missing release/tag from failed API access."""
import json
import os
import sys
import urllib.error
import urllib.request

version = sys.argv[1]
repo = os.environ['GITHUB_REPOSITORY']
for resource in [f'releases/tags/{version}', f'git/ref/tags/{version}']:
    request = urllib.request.Request(f'https://api.github.com/repos/{repo}/{resource}', headers={
        'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            json.load(response)
        raise SystemExit('Release or tag already exists; never overwrite a staged release')
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise SystemExit(f'GitHub availability check failed with HTTP {error.code}') from None
