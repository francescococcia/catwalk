# Vigil harness: local security check powered by Ministral

Rules decide **where to look** and **what counts as a finding**. Ministral (or Large 4) only **explains** each finding and suggests a fix. The model can't remove a finding or change the result, so a fooled model can't turn a BLOCK into a PASS.

- `packs/`: knowledge packs (`general`, `nextjs`, `supabase`), loaded based on the stack detected
- `vigil.py`: the scanner, standard library only, no install needed
- `sample/`: a deliberately vulnerable demo app (fake secrets)
- `test_vigil.py`: self-check, needs no model

## Run (PowerShell)

```powershell
cd harness
python test_vigil.py                       # self-check
python vigil.py scan sample --no-llm       # rules only, no model
```

### With Ministral through the Mistral API
```powershell
$env:MISTRAL_API_KEY = "<your key from console.mistral.ai/api-keys>"
$env:VIGIL_MODEL = "ministral-8b-latest"   # default; or ministral-3b-latest / ministral-14b-latest
python vigil.py scan sample
```

### With Large 4 (deeper explanations, slower and pricier)
```powershell
$env:VIGIL_MODEL = "mistral-large-4"
python vigil.py scan sample --json report.json
```

### Fully local with Ollama (tested)
```powershell
winget install --id Ollama.Ollama -e        # one time
ollama pull ministral-3:3b                  # one time, 3.0 GB
$env:VIGIL_BASE_URL = "http://localhost:11434/v1"
$env:VIGIL_MODEL = "ministral-3:3b"
python vigil.py scan sample
```
Measured on a laptop with a 4 GB NVIDIA T500 and 16 GB RAM: the model ran split about half CPU and half GPU, and explaining 7 findings took about 3 minutes (~25 s each). Use `--no-llm` for an instant check. A bigger GPU, or `ministral-3:8b` on 12 GB+, is faster and smarter.
LM Studio or llama.cpp work too: point `VIGIL_BASE_URL` at their `/v1` address.

Note: the 3B sometimes gets details of the fix wrong (e.g. naming the wrong variable). Treat its text as an explanation, not as the verdict. The verdict comes from the rules.

### Custom Ollama model with the reviewer settings built in
```powershell
ollama create vigil -f Modelfile           # temperature 0.1, 8k context, reviewer system prompt
$env:VIGIL_MODEL = "vigil"
python vigil.py scan sample --json report.json
```
It reuses the `ministral-3:3b` weights, so it takes no extra disk space.

### Cartoon replay of the workflow
```powershell
python vigil.py scan sample --json report.json
python -m http.server 8000                 # from the harness folder
# open http://localhost:8000/viewer/
```
Scout (rules) finds, Detective (Ministral / Large 4) explains, Mechanic proposes the fix, Gatekeeper shows BLOCK or PASS. Opening `viewer/index.html` directly plays a built-in demo run instead. You can also drag any `report.json` onto the page. The voice toggle uses browser speech as a stand-in for Voxtral, and the final "human approval" step is simulated.

### Use it as a gate
Exit code `1` = high or critical findings. Wire it into a pre-commit hook or a CI job, e.g. `python harness/vigil.py scan . --no-llm`.

## Dependencies and breaking changes (`--deps`)
```powershell
python vigil.py scan ..\demo-app --no-llm --deps
```
For every `package.json` (not in node_modules): `npm audit --json` (needs `package-lock.json`) gives one `dep-vulnerable` finding per vulnerable package (npm critical/high = block, moderate/low = suspect, with advisory title and fixed version), and `npm outdated --json` gives `dep-major-behind` when the latest major is ahead of the installed one ("upgrading may include breaking changes"). npm missing, offline or a timeout (60 s) prints a note and adds nothing. **Privacy:** npm audit sends the lockfile's package names and versions to the npm registry, not your code.

## Security report
```powershell
python report.py ..\demo-app --deps --out REPORT.md            # newest engine/runs/*.jsonl with a verdict
python report.py ..\demo-app --run ..\engine\runs\<file>.jsonl
```
Markdown with executive summary, red-team proofs (redacted evidence, fix diff, re-proof, rollback), findings table, per-finding detail with the Ministral explanation from the run log, blue-team monitoring ideas, compliance mapping, methodology (and what was not tested), appendix. Secret values are masked; the unredacted `evidence_local` body is never used. Example: `sample-report.md`.

## Standards mapping
`standards.json` maps each rule id to OWASP Top 10 2021, OWASP API Top 10 2023, OWASP LLM Top 10 2025 (where relevant), CWE, NIST SP 800-53 and ISO/IEC 27001:2022 Annex A. Every finding gets a `standards` field. **These mappings are guidance for reporting and triage, not a certification or an audit opinion.**

## Rules at a glance
Secrets: `hardcoded-secret`, `provider-secret` (AWS key id, PEM private key, GitHub, Stripe live, `sk-` tokens), `env-file-committed` (`.env*` except `.env.example`, unless the top-level .gitignore covers it), `nextjs-public-secret`, `supabase-service-role-in-client`. Access: `nextjs-api-no-ownership`, `nextjs-api-no-auth`, `nextjs-server-action-trusts-client`, `supabase-table-no-rls`, `supabase-rls-policy-true`. Auth: `jwt-unverified` (alg none / verify_signature off, block), `jwt-decode-no-verify`, `cookie-no-httponly`. Injection: `sql-string-building`, `eval-use`, `raw-html`, `prompt-injection-bait`. Config: `cors-wildcard`. Deps: `dep-vulnerable`, `dep-major-behind`. Matches of secret rules are masked in output.

## Add knowledge
Add a rule to a pack: `files` (glob patterns), `trigger` (regex), optional `absent` (a protection which, if present anywhere in the file, means no finding), `severity`, `ask` (the question for the model), `fix`.
