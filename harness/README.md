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

### Use it as a gate
Exit code `1` = high or critical findings. Wire it into a pre-commit hook or a CI job, e.g. `python harness/vigil.py scan . --no-llm`.

## Add knowledge
Add a rule to a pack: `files` (glob patterns), `trigger` (regex), optional `absent` (a protection which, if present anywhere in the file, means no finding), `severity`, `ask` (the question for the model), `fix`.
