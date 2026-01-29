#!/usr/bin/env node

// wildcard-domain-finder (streaming, old UX, round-robin DNS)
//
// - Wildcard patterns (* = single char)
// - TLD selection (explicit, all, premium)
// - Filtering (tld, length, starts, ends)
// - Streaming generation (no heap blowups)
// - Concurrency + timeout
// - Round-robin across many public resolvers (dns2)
// - Old-style UX: emoji progress, stats, recent found, current domain
// - Interactive: p = pause, r = resume, q = quit, Ctrl+C = interrupt

const fs = require('fs');
const readline = require('readline');
const { DNSClient } = require('dns2');

// Character set for wildcard expansion
const CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// TLD lists
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

// Domain validation regex
const DOMAIN_REGEX = /^(?=.{1,253}$)(?!.*\.\.)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

// Large public resolver pool (round-robin)
const RESOLVERS = [
  '1.1.1.1','1.0.0.1',
  '8.8.8.8','8.8.4.4',
  '9.9.9.9','149.112.112.112',
  '208.67.222.222','208.67.220.220',
  '185.228.168.9','185.228.169.9',
  '185.228.168.10','185.228.169.11',
  '94.140.14.14','94.140.15.15',
  '156.154.70.1','156.154.71.1',
  '4.2.2.1','4.2.2.2',
  '64.6.64.6','64.6.65.6'
];

let resolverIndex = 0;
function nextResolver() {
  const ip = RESOLVERS[resolverIndex];
  resolverIndex = (resolverIndex + 1) % RESOLVERS.length;
  return ip;
}

// Interactive state
let paused = false;
let quitting = false;
let currentDomain = '';
let recentlyFound = []; // last 3 available domains

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

  process.on('SIGINT', () => {
    console.log('\n\n⏹️  Process interrupted by user (Ctrl+C). Exiting...');
    process.exit(0);
  });
}

// ---------- CLI PARSING ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    pattern: null,
    tlds: null,
    allTlds: false,
    premiumTlds: false,
    filters: [],
    output: 'available_domains.txt',
    concurrency: 50,
    timeout: 3000
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-d' || a === '--domain') {
      opts.pattern = args[++i];
    } else if (a === '-t' || a === '--tlds') {
      const v = args[++i];
      if (v === 'all') opts.allTlds = true;
      else if (v === 'premium') opts.premiumTlds = true;
      else opts.tlds = v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    } else if (a === '-f' || a === '--filter') {
      opts.filters.push(args[++i]);
    } else if (a === '-o' || a === '--output') {
      opts.output = args[++i];
    } else if (a === '-c' || a === '--concurrency') {
      opts.concurrency = parseInt(args[++i], 10) || opts.concurrency;
    } else if (a === '-T' || a === '--timeout') {
      opts.timeout = parseInt(args[++i], 10) || opts.timeout;
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
🔍 Wildcard Domain Finder (streaming, old-style UX, round-robin DNS)

Usage:
  node app.js [options]

Domain Input:
  -d, --domain <pattern>       Wildcard pattern (* = single char)
  -t, --tlds <list|all|premium>
                               e.g. com,net,io | all | premium

Filtering:
  -f, --filter <rule>          Filter results:
                                 tld:com
                                 tld:com,io,net
                                 length<=3
                                 length>=2
                                 starts:go
                                 ends:ai

Output:
  -o, --output <file>          Output file path (txt, one domain per line)

Performance:
  -c, --concurrency <n>        DNS concurrency (default: 50)
  -T, --timeout <ms>           DNS timeout (default: 3000)

Interactive Controls:
  p                            Pause
  r                            Resume
  q                            Quit gracefully
  Ctrl+C                       Interrupt immediately
`);
}

// ---------- FILTERS ----------

function parseFilterRule(rule) {
  if (rule.startsWith('tld:')) {
    const list = rule.slice(4).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    return { type: 'tld', list };
  }

  if (rule.startsWith('length<=')) {
    const n = parseInt(rule.slice('length<='.length), 10);
    return { type: 'lengthMax', value: n };
  }
  if (rule.startsWith('length>=')) {
    const n = parseInt(rule.slice('length>='.length), 10);
    return { type: 'lengthMin', value: n };
  }

  if (rule.startsWith('starts:')) {
    const v = rule.slice('starts:'.length).toLowerCase();
    return { type: 'starts', value: v };
  }

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

// ---------- PATTERN GENERATION ----------

function* expandWildcardPattern(pattern) {
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
    const core = pattern.slice(0, -2);
    for (const base of expandWildcardPattern(core)) {
      for (const tld of tlds) {
        yield base + tld;
      }
    }
  } else {
    yield* expandWildcardPattern(pattern);
  }
}

// ---------- DNS (round-robin resolvers via dns2) ----------

async function checkDomain(domain, timeoutMs) {
  const resolver = nextResolver();
  const client = DNSClient({
    dns: resolver,
    port: 53,
    recursive: true
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)
  );

  try {
    const res = await Promise.race([
      client.resolve(domain, 'A'),
      timeout
    ]);
    const answers = res && res.answers ? res.answers : [];
    if (answers.length === 0) {
      return { domain, available: true, error: null };
    }
    return { domain, available: false, error: null };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return { domain, available: true, error: msg };
  }
}

// ---------- PROGRESS DISPLAY (old-style UX) ----------

function displayProgress(stats) {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const rate = stats.checked > 0 ? stats.checked / elapsed : 0;
  const percentage = stats.totalCandidates > 0
    ? (stats.checked / stats.totalCandidates) * 100
    : 0;

  const barWidth = 40;
  const filledWidth = Math.round((percentage / 100) * barWidth);
  const emptyWidth = barWidth - filledWidth;
  const progressBar = '█'.repeat(filledWidth) + '░'.repeat(emptyWidth);

  console.clear();
  console.log('🔍 Wildcard Domain Finder - Live Progress');
  console.log('='.repeat(70));
  console.log(`Progress: [${progressBar}] ${percentage.toFixed(1)}%`);
  console.log(`Status: ${stats.checked.toLocaleString()}/${stats.totalCandidates.toLocaleString()} domains checked`);
  console.log('');
  console.log('📊 Statistics:');
  console.log(`   ✅ Available: ${stats.available.toLocaleString()}`);
  console.log(`   ❌ Errors: ${stats.errors.toLocaleString()}`);
  console.log(`   ⏱️  Elapsed: ${elapsed.toFixed(1)}s`);
  console.log(`   🚀 Rate: ${rate.toFixed(1)} domains/sec`);
  console.log('');
  if (recentlyFound.length > 0) {
    console.log('🎯 Recently Found Available Domains:');
    recentlyFound.forEach((domain, index) => {
      const icon = index === 0 ? '🆕' : index === 1 ? '📌' : '📋';
      console.log(`   ${icon} ${domain}`);
    });
  } else {
    console.log('🔍 No available domains found yet...');
  }
  console.log('');
  console.log(`🔄 Currently checking: ${currentDomain || 'Initializing...'}`);
  console.log('='.repeat(70));
  console.log('💡 Keys: p = pause, r = resume, q = quit, Ctrl+C = interrupt');
}

// ---------- MAIN RUN (STREAMING) ----------

async function run() {
  const opts = parseArgs();

  if (!opts.pattern) {
    printHelp();
    process.exit(1);
  }

  const filters = buildFilters(opts.filters);

  let tlds;
  if (opts.allTlds) tlds = IANA_TLDS;
  else if (opts.premiumTlds) tlds = PREMIUM_TLDS;
  else if (opts.tlds && opts.tlds.length) tlds = opts.tlds;
  else tlds = ['com'];

  console.log(`🚀 Starting domain search`);
  console.log(`  Pattern: ${opts.pattern}`);
  console.log(`  TLDs:    ${tlds.join(', ')}`);
  console.log(`  Concurrency: ${opts.concurrency}, Timeout: ${opts.timeout}ms`);
  console.log(`  Output:  ${opts.output}`);
  console.log('\n💡 Keys: p = pause, r = resume, q = quit, Ctrl+C = interrupt\n');

  setupInteractiveControls();

  const iterator = expandPatternWithTlds(opts.pattern, tlds);
  const outStream = fs.createWriteStream(opts.output, { flags: 'w' });

  const stats = {
    totalCandidates: 0,
    checked: 0,
    available: 0,
    errors: 0,
    startTime: Date.now()
  };

  let active = 0;
  const tasks = [];
  let lastProgressUpdate = 0;
  let done = false;

  async function scheduleNext() {
    if (quitting || done) return;
    while (!paused && active < opts.concurrency && !done) {
      const { value: domain, done: isDone } = iterator.next();
      if (isDone) {
        done = true;
        break;
      }

      stats.totalCandidates++;

      if (!isValidDomain(domain)) continue;
      if (!passesFilters(domain, filters)) continue;

      active++;
      currentDomain = domain;

      const task = (async () => {
        const res = await checkDomain(domain, opts.timeout);
        stats.checked++;

        if (res.available) {
          stats.available++;
          outStream.write(domain + '\n');

          recentlyFound.unshift(domain);
          if (recentlyFound.length > 3) recentlyFound.pop();
        } else if (res.error) {
          stats.errors++;
        }

        const now = Date.now();
        if (now - lastProgressUpdate > 500 || (done && active === 0)) {
          lastProgressUpdate = now;
          displayProgress(stats);
        }
      })().finally(() => {
        active--;
      });

      tasks.push(task);
    }
  }

  while (!done || active > 0) {
    if (quitting && active === 0) break;
    if (!paused) {
      await scheduleNext();
    }
    await sleep(50);
  }

  await Promise.all(tasks);
  outStream.end();

  const totalTime = (Date.now() - stats.startTime) / 1000;
  console.clear();
  console.log('🎉 Domain Search Completed');
  console.log('='.repeat(60));
  console.log(`📊 Total candidates generated: ${stats.totalCandidates.toLocaleString()}`);
  console.log(`📊 Total domains checked:      ${stats.checked.toLocaleString()}`);
  console.log(`✅ Available domains found:    ${stats.available.toLocaleString()}`);
  console.log(`❌ Errors encountered:         ${stats.errors.toLocaleString()}`);
  console.log(`⏱️  Total time:                ${totalTime.toFixed(1)}s`);
  console.log(`🚀 Average rate:               ${(stats.checked / totalTime).toFixed(1)} domains/sec`);
  console.log(`📁 Results saved to:           ${opts.output}`);
  if (stats.available > 0) {
    console.log('');
    console.log('🎯 Recently Found Available Domains:');
    recentlyFound.forEach((d, i) => {
      console.log(`   ${i + 1}. ${d}`);
    });
  } else {
    console.log('');
    console.log('😔 No available domains found with this pattern.');
  }
  console.log('='.repeat(60));
}

run().catch(err => {
  console.error('Fatal error:', err);
  process