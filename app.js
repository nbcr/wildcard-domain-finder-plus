#!/usr/bin/env node

// wildcard-domain-finder (upgraded)
// - Supports wildcard patterns (* = single char)
// - Optional regex mode
// - TLD selection (explicit, all, premium)
// - Filtering (tld, length, starts, ends)
// - Sorting (comfirst, tld, length, alpha)
// - Output formats: txt, json, jsonl, csv
// - Caching + resume via JSONL
// - Streaming generation (no heap blowups)
// - Concurrency + timeout
// - Interactive pause/resume/quit (p/r/q)

const fs = require('fs');
const dns = require('dns').promises;
const readline = require('readline');

const CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const IANA_TLDS = [
  'com','net','org','edu','gov','mil','int',
  'ca','us','uk','de','fr','au','jp','cn','io','ai','co','me','tv','cc',
  'xyz','info','biz','name','pro','tech','dev','app','cloud','store','shop',
  'site','online','space','fun','live','world','today','news','media','social',
  'group','club','team','company','agency','solutions','systems','network',
  'software','digital','finance','capital','partners','ventures','consulting',
  'services','support','help','care','health','clinic','law','legal',
  'design','photo','photos','gallery','art','music','video','games','game',
  'blog','wiki','school','academy','training','university','science',
  'research','energy','solar','green','eco','earth','bio','farm','garden',
  'coffee','pizza','bar','restaurant','kitchen','food','wine','beer',
  'fashion','style','beauty','spa','travel','vacations','holiday','flights',
  'hotel','rentals','cars','auto','car','bike','homes','house','realty',
  'estate','property','land','city','zone','global','africa','asia','europe'
];

const PREMIUM_TLDS = ['com','net','org','io','ai','co','dev','app','xyz','tech'];

const DOMAIN_REGEX = /^(?=.{1,253}$)(?!.*\.\.)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

let paused = false;
let quitting = false;

function isValidDomain(domain) {
  return DOMAIN_REGEX.test(domain);
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function setupInteractiveControls() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;
    if (key.name === 'p') {
      paused = true;
      process.stdout.write('\n⏸️  Paused. Press r to resume, q to quit.\n');
    }
    if (key.name === 'r') {
      paused = false;
      process.stdout.write('\n▶️  Resumed.\n');
    }
    if (key.name === 'q') {
      quitting = true;
      process.stdout.write('\n🛑 Quitting gracefully...\n');
    }
  });
}

// ---------- CLI PARSING ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    pattern: null,
    regex: null,
    tlds: null,
    allTlds: false,
    premiumTlds: false,
    filters: [],
    sort: null,
    format: 'txt',
    output: 'available_domains.txt',
    concurrency: 10,
    timeout: 5000,
    resume: false,
    cacheFile: 'checked_domains.jsonl',
    useCache: true,
    maxLength: 4
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-d' || a === '--domain') {
      opts.pattern = args[++i];
    } else if (a === '-r' || a === '--regex') {
      opts.regex = args[++i];
    } else if (a === '-t' || a === '--tlds') {
      const v = args[++i];
      if (v === 'all') opts.allTlds = true;
      else if (v === 'premium') opts.premiumTlds = true;
      else opts.tlds = v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    } else if (a === '-f' || a === '--filter') {
      opts.filters.push(args[++i]);
    } else if (a === '-s' || a === '--sort') {
      opts.sort = args[++i]; // comfirst | tld | length | alpha
    } else if (a === '-F' || a === '--format') {
      opts.format = args[++i].toLowerCase(); // txt | json | jsonl | csv
    } else if (a === '-o' || a === '--output') {
      opts.output = args[++i];
    } else if (a === '-c' || a === '--concurrency') {
      opts.concurrency = parseInt(args[++i], 10) || 10;
    } else if (a === '-T' || a === '--timeout') {
      opts.timeout = parseInt(args[++i], 10) || 5000;
    } else if (a === '-R' || a === '--resume') {
      opts.resume = true;
    } else if (a === '--no-resume') {
      opts.resume = false;
    } else if (a === '-C' || a === '--cache') {
      opts.cacheFile = args[++i];
    } else if (a === '--no-cache') {
      opts.useCache = false;
    } else if (a === '--max-length') {
      opts.maxLength = parseInt(args[++i], 10) || 4;
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
Wildcard Domain Finder (upgraded)

Usage:
  wildcard-domain-finder [options]

Domain Input:
  -d, --domain <pattern>       Wildcard pattern (* = single char)
  -r, --regex <regex>          Regex pattern for full domain
  -t, --tlds <list>            Comma-separated TLDs (e.g. com,net,io)
      --tlds all               Use all known TLDs
      --tlds premium           Use premium TLD list
      --max-length <n>         Max label length for regex mode (default: 4)

Filtering:
  -f, --filter <rule>          Filter results:
                                 tld:com
                                 tld:com,io,net
                                 length<=3
                                 length>=2
                                 starts:go
                                 ends:ai

Sorting:
  -s, --sort <mode>            Sort results:
                                 comfirst   (.com first)
                                 tld        group by TLD
                                 length     shortest first
                                 alpha      alphabetical

Output:
  -F, --format <fmt>           txt | json | jsonl | csv
  -o, --output <file>          Output file path

Performance:
  -c, --concurrency <n>        DNS concurrency (default: 10)
  -T, --timeout <ms>           DNS timeout (default: 5000)

Resume / Cache:
  -R, --resume                 Resume from cache (skip already checked)
      --no-resume              Ignore cache
  -C, --cache <file>           Cache file (default: checked_domains.jsonl)
      --no-cache               Disable caching

Interactive Controls:
      p                        Pause
      r                        Resume
      q                        Quit gracefully
`);
}

// ---------- FILTERS & SORTING ----------

function parseFilterRule(rule) {
  // tld:com,io
  if (rule.startsWith('tld:')) {
    const list = rule.slice(4).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    return { type: 'tld', list };
  }

  // length<=3, length>=2
  if (rule.startsWith('length<=')) {
    const n = parseInt(rule.slice('length<='.length), 10);
    return { type: 'lengthMax', value: n };
  }
  if (rule.startsWith('length>=')) {
    const n = parseInt(rule.slice('length>='.length), 10);
    return { type: 'lengthMin', value: n };
  }

  // starts:go
  if (rule.startsWith('starts:')) {
    const v = rule.slice('starts:'.length).toLowerCase();
    return { type: 'starts', value: v };
  }

  // ends:ai
  if (rule.startsWith('ends:')) {
    const v = rule.slice('ends:'.length).toLowerCase();
    return { type: 'ends', value: v };
  }

  return null;
}

function buildFilters(filterStrings) {
  return filterStrings
    .map(parseFilterRule)
    .filter(Boolean);
}

function passesFilters(domain, filters) {
  if (!filters.length) return true;

  const [name, tld] = (() => {
    const parts = domain.split('.');
    const tld = parts.pop().toLowerCase();
    const name = parts.join('.').toLowerCase();
    return [name, tld];
  })();

  for (const f of filters) {
    if (f.type === 'tld') {
      if (!f.list.includes(tld)) return false;
    } else if (f.type === 'lengthMax') {
      if (name.length > f.value) return false;
    } else if (f.type === 'lengthMin') {
      if (name.length < f.value) return false;
    } else if (f.type === 'starts') {
      if (!name.startsWith(f.value)) return false;
    } else if (f.type === 'ends') {
      if (!name.endsWith(f.value)) return false;
    }
  }

  return true;
}

function sortResults(results, mode) {
  if (!mode) return results;

  if (mode === 'comfirst') {
    return results.sort((a, b) => {
      const aCom = a.tld === 'com' ? 0 : 1;
      const bCom = b.tld === 'com' ? 0 : 1;
      if (aCom !== bCom) return aCom - bCom;
      return a.domain.localeCompare(b.domain);
    });
  }

  if (mode === 'tld') {
    return results.sort((a, b) => {
      if (a.tld !== b.tld) return a.tld.localeCompare(b.tld);
      return a.domain.localeCompare(b.domain);
    });
  }

  if (mode === 'length') {
    return results.sort((a, b) => {
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.domain.localeCompare(b.domain);
    });
  }

  if (mode === 'alpha') {
    return results.sort((a, b) => a.domain.localeCompare(b.domain));
  }

  return results;
}

// ---------- PATTERN / REGEX GENERATION ----------

function* expandWildcardPattern(pattern) {
  // * = single char from CHARSET
  function* helper(index, prefix) {
    if (index === pattern.length) {
      yield prefix;
      return;
    }
    const ch = pattern[index];
    if (ch === '*') {
      for (const c of CHARSET) {
        yield* helper(index + 1, prefix + c);
      }
    } else {
      yield* helper(index + 1, prefix + ch);
    }
  }
  yield* helper(0, '');
}

function* expandPatternWithTlds(pattern, tlds) {
  if (pattern.endsWith('.*')) {
    const core = pattern.slice(0, -2); // keep trailing dot
    for (const base of expandWildcardPattern(core)) {
      for (const tld of tlds) {
        yield base + tld;
      }
    }
  } else {
    yield* expandWildcardPattern(pattern);
  }
}

function* generateAllDomainsForRegex(maxLength, tlds) {
  function* build(prefix, depth) {
    if (depth === 0) {
      for (const tld of tlds) {
        yield prefix + '.' + tld;
      }
      return;
    }
    for (const c of CHARSET) {
      yield* build(prefix + c, depth - 1);
    }
  }

  for (let len = 1; len <= maxLength; len++) {
    yield* build('', len);
  }
}

// ---------- DNS + CACHE ----------

async function checkDomain(domain, timeoutMs) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)
  );

  try {
    await Promise.race([
      dns.resolveAny(domain),
      timeout
    ]);
    return { domain, available: false, error: null };
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      return { domain, available: true, error: null };
    }
    if (err.message === 'TIMEOUT') {
      return { domain, available: null, error: 'timeout' };
    }
    return { domain, available: null, error: err.code || err.message };
  }
}

function loadCache(cacheFile) {
  const map = new Map();
  if (!fs.existsSync(cacheFile)) return map;
  const lines = fs.readFileSync(cacheFile, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.domain) map.set(obj.domain, obj);
    } catch {
      // ignore bad lines
    }
  }
  return map;
}

function appendToCache(cacheFile, obj) {
  fs.appendFileSync(cacheFile, JSON.stringify(obj) + '\n');
}

// ---------- OUTPUT ----------

function writeOutput(results, opts) {
  const out = opts.output;
  const fmt = opts.format;

  if (fmt === 'txt') {
    const lines = results.map(r => r.domain);
    fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
    console.log(`✅ Saved ${results.length} domains to ${out} (txt).`);
    return;
  }

  if (fmt === 'json') {
    fs.writeFileSync(out, JSON.stringify(results, null, 2), 'utf8');
    console.log(`✅ Saved ${results.length} domains to ${out} (json).`);
    return;
  }

  if (fmt === 'jsonl') {
    const lines = results.map(r => JSON.stringify(r));
    fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
    console.log(`✅ Saved ${results.length} domains to ${out} (jsonl).`);
    return;
  }

  if (fmt === 'csv') {
    const header = 'domain,tld,name,available,checkedAt,error\n';
    const rows = results.map(r =>
      `${r.domain},${r.tld},${r.name},${r.available},${r.checkedAt},${r.error || ''}`
    );
    fs.writeFileSync(out, header + rows.join('\n') + '\n', 'utf8');
    console.log(`✅ Saved ${results.length} domains to ${out} (csv).`);
    return;
  }

  // fallback
  const lines = results.map(r => r.domain);
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  console.log(`✅ Saved ${results.length} domains to ${out} (txt fallback).`);
}

// ---------- MAIN RUN ----------

async function run() {
  const opts = parseArgs();

  if (!opts.pattern && !opts.regex) {
    printHelp();
    process.exit(1);
  }

  const filters = buildFilters(opts.filters);

  let tlds;
  if (opts.allTlds) tlds = IANA_TLDS;
  else if (opts.premiumTlds) tlds = PREMIUM_TLDS;
  else if (opts.tlds && opts.tlds.length) tlds = opts.tlds;
  else tlds = ['com'];

  let regex = null;
  if (opts.regex) {
    try {
      regex = new RegExp(opts.regex);
    } catch (err) {
      console.error('Invalid regex:', err.message);
      process.exit(1);
    }
  }

  const cache = opts.useCache ? loadCache(opts.cacheFile) : new Map();

  console.log(`🚀 Starting domain search`);
  if (opts.pattern) console.log(`  Pattern: ${opts.pattern}`);
  if (regex) console.log(`  Regex:   ${opts.regex}`);
  console.log(`  TLDs:    ${tlds.join(', ')}`);
  console.log(`  Concurrency: ${opts.concurrency}, Timeout: ${opts.timeout}ms`);
  console.log(`  Output:  ${opts.output} (${opts.format})`);
  if (opts.useCache) console.log(`  Cache:   ${opts.cacheFile} (${cache.size} entries loaded)`);

  setupInteractiveControls();

  const iterator = regex
    ? generateAllDomainsForRegex(opts.maxLength, tlds)
    : expandPatternWithTlds(opts.pattern, tlds);

  const availableResults = [];
  const tasks = [];
  let active = 0;
  let checked = 0;
  let totalCandidates = 0;
  const startTime = Date.now();

  async function scheduleNext() {
    if (quitting) return;
    while (!paused && active < opts.concurrency) {
      const next = iterator.next();
      if (next.done) break;
      const domain = next.value;
      totalCandidates++;

      if (!isValidDomain(domain)) continue;
      if (!passesFilters(domain, filters)) continue;

      if (opts.useCache && cache.has(domain)) {
        continue;
      }

      active++;
      const task = (async () => {
        const res = await checkDomain(domain, opts.timeout);
        checked++;

        const [name, tld] = (() => {
          const parts = domain.split('.');
          const tld = parts.pop().toLowerCase();
          const name = parts.join('.').toLowerCase();
          return [name, tld];
        })();

        const record = {
          domain,
          name,
          tld,
          available: res.available,
          checkedAt: new Date().toISOString(),
          error: res.error
        };

        if (opts.useCache) {
          cache.set(domain, record);
          appendToCache(opts.cacheFile, record);
        }

        if (res.available === true) {
          availableResults.push(record);
          process.stdout.write(
            `\rChecked: ${checked.toLocaleString()} | Available: ${availableResults.length.toLocaleString()}   `
          );
        }
      })().finally(() => {
        active--;
      });

      tasks.push(task);
    }
  }

  while (true) {
    if (quitting) break;
    if (!paused) {
      await scheduleNext();
    }
    if (active === 0 && iterator.next().done) {
      break;
    }
    await sleep(100);
  }

  await Promise.all(tasks);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n⏱  Done in ${duration}s. Checked ${checked.toLocaleString()} domains.`);
  console.log(`✅ Available: ${availableResults.length.toLocaleString()}`);

  const sorted = sortResults(availableResults, opts.sort);
  writeOutput(sorted, opts);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
