## Attribution

This project is an enhanced fork of  
**besoeasy/wildcard-domain-finder**  
Original work © the respective author(s), licensed under the ISC License.

This fork adds major new capabilities including:
- streaming domain generation (no memory blowups)
- regex mode
- wildcard mode
- TLD selection (explicit, all, premium)
- filtering (tld, length, starts, ends)
- sorting (comfirst, tld, length, alpha)
- JSON / JSONL / CSV / TXT output
- caching + resume mode
- interactive pause/resume/quit controls
- concurrency + timeout controls
- full CLI help system

All original licensing terms are preserved.

---

# Wildcard Domain Finder Plus

A command-line tool to find available domain names using wildcard patterns, regex patterns, or structured filters — now with streaming generation, caching, and advanced TLD control.

---

# Quick Start

Install globally:

    npm install -g wildcard-domain-finder-plus

Run a simple wildcard scan:

    wildcard-domain-finder-plus -d "test*.com"

Run a regex scan:

    wildcard-domain-finder-plus --regex "^[a-z]{3}\\.com$"

Scan all TLDs:

    wildcard-domain-finder-plus -d "go*" --tlds all

---

# Installation

### Via NPX (no installation required)

    npx wildcard-domain-finder-plus

### Or install globally

    npm install -g wildcard-domain-finder-plus

---

# Usage Guide

Wildcard Domain Finder Plus supports three primary modes:

1. Wildcard mode  
2. Regex mode  
3. Structured filtering mode  

Each mode can be combined with TLD selection, sorting, output formatting, and caching.

---

## Wildcard Mode

Use * to represent any single alphanumeric character (a–z, 0–9).

Example:

    wildcard-domain-finder-plus -d "test*.com"

This expands to:

- testa.com  
- testb.com  
- test1.com  
- …and so on  

Wildcard mode is ideal when you know the pattern but not the exact characters.

---

## Regex Mode

Regex mode gives you full control over domain label generation.

Example:

    wildcard-domain-finder-plus --regex "^[a-z0-9]{3}\\.com$"

This generates:

- aaa.com  
- aab.com  
- …  
- zzz.com  

Regex mode supports:

- character classes  
- alternation  
- anchors  
- quantifiers  
- grouping  

---

# Regex Helper

### Three‑letter domains

    ^[a-z]{3}\\.(com|net|org)$

### Two letters + one digit

    ^[a-z]{2}[0-9]\\.com$

### Start with “go”, then any 2 chars

    ^go[a-z0-9]{2}\\.io$

### Premium TLDs only

    ^[a-z]{3,5}\\.(ai|io|dev)$

### Only letters (no digits)

    ^[a-z]+\\.(com|net)$

### Letters + optional hyphen

    ^[a-z]+(-[a-z]+)?\\.com$

### Multiple TLDs

    ^[a-z]{4}\\.(com|io|ai|co)$

---

# TLD Selection

Choose from:

- explicit list  
- all known TLDs  
- premium curated list  

Examples:

    wildcard-domain-finder-plus -d "go*" --tlds all

    wildcard-domain-finder-plus -d "ai*" --tlds premium

    wildcard-domain-finder-plus -d "shop*" --tlds com,net,org,io

---

# Filtering

Filters allow you to refine generated domains.

Supported filters:

- tld:com  
- length<=3  
- starts:go  
- ends:ai  

Examples:

    wildcard-domain-finder-plus -d "***.com" --filter length<=3

    wildcard-domain-finder-plus -d "*ai" --filter ends:ai

    wildcard-domain-finder-plus -d "go*" --filter starts:go

---

# Sorting

Sorting options:

- comfirst  
- tld  
- length  
- alpha  

Example:

    wildcard-domain-finder-plus -d "***.com" --sort comfirst

---

# Output Formats

Choose from:

- txt  
- json  
- jsonl  
- csv  

Example:

    wildcard-domain-finder-plus -d "go*" -F jsonl -o results.jsonl

---

# Caching and Resume Mode

Large scans can be resumed:

    wildcard-domain-finder-plus -R

Disable caching:

    wildcard-domain-finder-plus --no-cache

---

# Interactive Mode

If no domain or regex is provided:

    wildcard-domain-finder-plus

You will be prompted for:

- mode  
- pattern  
- TLDs  
- filters  
- output format  

---

# Common Recipes

### Find all 3‑letter .com domains

    wildcard-domain-finder-plus --regex "^[a-z]{3}\\.com$"

### Find all domains starting with “go” across all TLDs

    wildcard-domain-finder-plus -d "go*" --tlds all

### Find short premium domains

    wildcard-domain-finder-plus -d "***" --tlds premium --filter length<=3

### Find 4‑letter .io or .ai domains

    wildcard-domain-finder-plus --regex "^[a-z]{4}\\.(io|ai)$"

### Wildcard + filtering + sorting

    wildcard-domain-finder-plus -d "go**.com" --filter length<=4 --sort alpha

---

# Performance Tips

### 1. Increase concurrency for faster scans

    --concurrency 50

### 2. Reduce DNS timeout for faster failures

    --timeout 2000

### 3. Use JSONL for huge output sets

    -F jsonl

### 4. Use resume mode for long scans

    -R

### 5. Limit search space with filters

    --filter length<=4  
    --filter starts:go  
    --filter tld:com  

### 6. Prefer regex for structured patterns

Regex mode avoids generating unnecessary combinations.

---

# Full Examples

### Wildcard + premium TLDs

    wildcard-domain-finder-plus -d "ai*" --tlds premium

### Regex + JSONL output

    wildcard-domain-finder-plus --regex "^[a-z]{4}\\.(io|ai)$" -F jsonl

### Resume a long scan

    wildcard-domain-finder-plus -R

---

# Features

- ⚡ Streaming domain generation (no memory blowups)
- 🃏 Wildcard mode (* = single character)
- 🔍 Regex mode
- 🌍 TLD selection (explicit, all, premium)
- 🧹 Filtering (tld, length, starts, ends)
- 🔃 Sorting (comfirst, tld, length, alpha)
- 📝 Multiple output formats (txt, json, jsonl, csv)
- 💾 Caching + resume mode
- ⏸️ Interactive pause/resume/quit
- ⏱️ Concurrency + timeout controls
- 🛡️ Graceful error handling
- ❓ Full CLI help system

---

# License

ISC  
All original licensing terms are preserved.

---

# Links

- NPM Package: https://www.npmjs.com/package/wildcard-domain-finder-plus  
- GitHub Repository: https://github.com/nbcr/wildcard-domain-finder-plus  
- Issues: https://github.com/nbcr/wildcard-domain-finder-plus/issues  
