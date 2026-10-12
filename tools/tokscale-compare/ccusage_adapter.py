"""Pinned ccusage aggregate comparison; executable runs only inside suite sandbox."""
import hashlib
import json
from pathlib import Path

SUPPORTED_CLIENTS = ('claude', 'codex', 'pi', 'gemini', 'copilot')
VERSION = '20.0.24'
BINARY_SHA256 = 'd8979af0f2ca2ee523ee641ea01e2ea99cdf55d7f7c460eeedb623f8c599b397'
PIN = f'ccusage@{VERSION}:linux-x64:sha256:{BINARY_SHA256}'


def availability(config):
    binary = Path(config.get('binary', '/nonexistent')).expanduser()
    if not binary.is_file():
        return {'status': 'unavailable', 'pin': PIN, 'reason': 'Set ccusage.binary to the pinned native executable; suite never downloads.'}
    actual = hashlib.sha256(binary.read_bytes()).hexdigest()
    if actual != BINARY_SHA256:
        return {'status': 'unavailable', 'pin': PIN, 'reason': f'Binary digest mismatch: {actual}'}
    return {'status': 'available', 'pin': PIN}


def execute(config, spec, home, sandbox):
    state = availability(config)
    if state['status'] != 'available':
        return state
    client = spec['client']
    if client not in SUPPORTED_CLIENTS:
        return {'status': 'unavailable', 'pin': PIN, 'reason': f'Unsupported fixture client: {client}'}
    binary = Path(config['binary']).expanduser().resolve()
    bindings = [(home, '/fixtures'), (binary, '/ccusage')]
    env = ['/usr/bin/env', 'HOME=/fixtures', 'CLAUDE_CONFIG_DIR=/fixtures/.claude',
           'CODEX_HOME=/fixtures/.codex', 'PI_CODING_AGENT_DIR=/fixtures/.pi/agent',
           'XDG_CONFIG_HOME=/tmp/config', 'XDG_CACHE_HOME=/tmp/cache', 'TZ=UTC', 'NO_COLOR=1']
    version = sandbox(bindings, env + ['/ccusage', '--version']).strip()
    if version != f'ccusage {VERSION}':
        raise ValueError(f'Unexpected ccusage version: {version}')
    raw = json.loads(sandbox(bindings, env + ['/ccusage', client, 'daily', '--json', '--offline', '--timezone', 'UTC']))
    totals = raw.get('totals')
    if not isinstance(totals, dict):
        raise ValueError('ccusage report lacks totals; do not invent zero usage')
    fields = {'input': 'inputTokens', 'output': 'outputTokens',
              'cacheRead': 'cacheReadTokens', 'cacheWrite': 'cacheCreationTokens'}
    aggregate = {}
    for key, source in fields.items():
        value = totals.get(source)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f'Invalid or missing ccusage token field: {source}')
        aggregate[key] = value
    expected = {key: sum(row[key] for row in spec['expected']) for key in fields}
    return {'status': 'executed', 'pin': PIN,
            'observation': {'aggregate': aggregate, 'reportedTotalTokens': totals.get('totalTokens'),
                            'identity': 'not exposed by daily aggregate CLI',
                            'outputSemantics': 'reported outputTokens; no invented reasoning breakdown'},
            'sourceComparison': {'expected': expected, 'actual': aggregate, 'matches': aggregate == expected},
            'raw': raw}
