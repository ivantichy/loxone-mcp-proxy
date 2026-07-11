# CLAUDE.md — loxone-mcp-proxy

Lokální zero-dependency proxy, která zpřístupňuje Loxone Miniserver (Ivanův
byt) jako MCP server pro Claude Desktop. Přihlašovací údaje k Miniserveru se
nikdy necommitují.

## Globální pravidla (převzato z cowork-skills)

- Před úpravou sdíleného dokumentu nebo kódu si vždy znovu načti aktuální
  znění z disku. Neopírej se o starší výpis nebo shrnutí z kontextu, soubory
  se mezi sessions mění.
- Piš bez AI klišé: žádná pomlčka (—) ani --, žádné fráze typu „v dnešní
  době", „je důležité poznamenat", žádné konstrukce „nejen X, ale i Y" ani
  prázdná přídavná jména. Šetři tučným písmem, nadpisy a odrážkami, žádné
  emoji. Platí pro commit zprávy, dokumentaci i komunikaci s uživatelem.
- Drž kontext malý: grep nebo čtení s offsetem místo celých souborů, velké
  logy do konverzace netahej. Deterministické kroky (testy, ověření)
  spouštěj jako skript, který vrátí pár řádků (PASS/FAIL a co selhalo).
  Nezávislé tool cally posílej v jednom kole.
- Mechanickou práci (hledání, čtení, ověřování, rutinní implementace)
  deleguj na levné subagenty (haiku/sonnet), nejsilnější model nech pro
  hlavní vlákno a rozhodování. Na závěr session spusť review subagenta
  (Sonnet, u riskantních změn nejsilnější model): projde konverzaci a změny,
  vrátí krátký report nálezů.
- Dlouhou práci děl na uzavřené bloky (audit, návrh, implementace, testy)
  a mezi bloky navrhni pokračovat novou session; stav je v gitu. Kontext nad
  ~150k tokenů je signál k řezu.
- Verzované změny commitni a pushni na závěr session; trvalý stav ještě
  během běhu, scoped:
  `powershell -File C:\temp\Claude\cowork-skills\tools\commit_state.ps1 -Repo <repo> -Paths <soubory> -Message "<co>"`.
- Trvalý poznatek (pravidlo, workaround, oprava postupu) nesmí zůstat jen
  v chatu: zapiš ho do `C:\temp\Claude\cowork-skills\learnings\inbox.md`
  + commit. Skilly, globální instrukce ani task prompty se bez Ivanova
  schválení nemění.
- Destruktivní hromadná operace = nejdřív protokol, pak spustit:
  (1) čistý git strom nebo commit/stash, (2) dry-run na jednom souboru,
  (3) ověř výsledek, (4) teprve pak spusť hromadně.
- Na začátku práce nad verzovanými soubory zkontroluj `git status`. Špinavý
  strom vyřeš (commit, stash, izolovaná větev) dřív, než začneš zapisovat.
- Na závěr session ověř, že se aktualizovala dokumentace (README), pokud se
  měnilo chování.
