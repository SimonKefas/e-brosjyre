# E-brosjyre

En gratis PDF-brosjyreviser i HTML, CSS og JavaScript. Bygget for Webflow og andre nettsider. PDF-en ligger hos deg; du angir en offentlig URL. Ingen konto, opplastingsserver, sporing eller betalt brosjyretjeneste.

## Prøv lokalt

Krever Node.js 22.13+ (eller 24+).

```sh
npm ci
npm run dev
```

Åpne http://127.0.0.1:4173. Demoen inneholder en egen seks siders eksempel-PDF. Velg **Bytt PDF** for å prøve en annen URL. `npm run build` lager hele publiseringspakken i `dist/`. Serveren bruker `KAI_PREVIEW_PORT`, deretter `PORT`, ellers 4173.

## Bruk i Webflow

1. Last opp PDF-en i Webflow Assets eller på en annen filvert. Kopier en offentlig lenke direkte til filen, ikke en delingsside eller forhåndsvisning som krever innlogging.
2. Legg til et **Code Embed**-element i Webflow. Sett inn koden nedenfor med din PDF-adresse. Publiser siden for å teste. Webflows tilgang til egendefinert kode avhenger av planen din; en gratis viser gjør ikke Webflow-abonnementet gratis.

```html
<script type="module" src="https://cdn.jsdelivr.net/gh/SimonKefas/e-brosjyre@v1.0.0/dist/ebrosjyre.js"></script>
<e-brosjyre
  src="https://DIN-PDFVERT.no/brosjyre.pdf"
  title="Vår brosjyre"
  spread="always"
  chrome="full"
></e-brosjyre>
```

Viseren hentes fra jsDelivr, som leverer `dist/` rett fra dette GitHub-repoet. Du trenger ingen egen filvert for viseren. Adressen er låst til en versjonstagg (`@v1.0.0`): bruk alltid en tagg, aldri `@main` eller `@latest`, så en senere endring i repoet ikke kan endre eller knekke en publisert side. Vil du heller hoste viseren selv, publiser hele innholdet i `dist/` (med undermappene) på en statisk HTTPS-filvert og pek `src` i `<script>` dit.

`src` er det eneste du trenger å bytte når PDF-en endres. Sett en beskrivende `title`.

### Én eller to sider: `spread`

`spread` bestemmer hvor mange sider leseren ser om gangen. Forsiden og siste side vises alltid alene, som i en ekte brosjyre.

| Verdi | Visning | Når du bør velge den |
| --- | --- | --- |
| `always` (standard) | To og to sider, også på mobil. | Brosjyrer med sammenhengende design over to sider, der oppslaget er ett bilde. |
| `auto` | To og to, men én side om gangen på smale skjermer (omtrent under 230 px per side). | Brosjyrer der hver side står for seg og bør være størst mulig på telefon. |
| `single` | Alltid én side om gangen. | Dokumenter som leses side for side, for eksempel rapporter. |

Utelater du `spread`, eller skriver en ukjent verdi, brukes `always`. Du kan endre attributtet med JavaScript mens siden er åpen.

På telefon blir to stående sider smale: på en 390 px bred skjerm blir hver A4-side omtrent 180 × 255 px, og liten tekst må leses med zoom (knip eller dobbelttrykk) eller i fullskjerm med telefonen på tvers. Velg `auto` hvis teksten er viktigere enn helheten i oppslaget.

### Rammen rundt boken: `chrome`

`chrome` bestemmer hvor mye av viserens egen ramme som vises. Med `minimal` og `none` ligger brosjyren rett på nettsidens bakgrunn, som et designelement.

| Verdi | Visning | Når du bør velge den |
| --- | --- | --- |
| `full` (standard) | Mørk boks med verktøylinje (sidetall, sidelinje, zoom, original-PDF og fullskjerm) og pilknapper. | Når brosjyren skal ha en tydelig leserflate. |
| `minimal` | Gjennomsiktig bakgrunn. Verktøylinjen og pilene finnes fortsatt, men uten egne flater, og får nettsidens tekstfarge. All funksjonalitet beholdes. | Når brosjyren skal gli inn i siden, men leseren fortsatt skal ha knapper. |
| `none` | Bare boken. Ingen verktøylinje, piler, sidetall, zoomknapper eller fullskjermknapp. Leseren blar med dra, sveip og piltaster, og kan knipe eller dobbelttrykke for å zoome. | Når brosjyren er et rent designelement på siden. |

Utelater du `chrome`, eller skriver en ukjent verdi, brukes `full`. Du kan endre attributtet med JavaScript mens siden er åpen. Med `minimal` og `none` arver knappene og meldingene tekstfargen fra nettsiden; sett `color` på elementet (for eksempel `style="color:#1d2b22"`) hvis den ikke passer. I fullskjerm får alle variantene den mørke bakgrunnen tilbake.

Med `none` er kontrollene fortsatt der for skjermlesere og tastatur, men skjult for øyet. Den som går med Tab inn i brosjyren, ser pilene og verktøylinjen dukke opp over boken mens de har fokus. Slik kan brosjyren også brukes av den som ikke kan dra eller sveipe. Høyden tilpasses uten verktøylinjen, så det blir ikke et tomt felt under boken.

### Lenke til en bestemt side: `deep-link`

Adressen i nettleseren følger siden leseren er på: blar de til side 8, blir adressen `…/brosjyre#side=8`. Deler de lenken, åpner mottakeren brosjyren på samme sted. Du kan også lenke dit selv, for eksempel `<a href="#side=12">Se prislisten</a>` på samme nettside, eller `https://din-nettside.no/katalog#side=12` i en e-post.

- Adressen byttes ut på stedet (`history.replaceState`). Nettleserens historikk fylles ikke med ett steg per side, så tilbakeknappen tar leseren rett tilbake til forrige nettside.
- Forsiden trenger ikke noe sidetall, og der fjernes `#side=` fra adressen.
- Et sidetall som ikke finnes i PDF-en (`#side=99`, `#side=abc`), åpner forsiden.
- Viseren rører aldri en `#`-adresse som tilhører nettsiden selv. Har leseren klikket på et anker som `#kontakt`, blir den stående, og bla-ingen endrer ikke adressen.
- Har siden flere visere, er det bare den første som følger adressen. De andre lar den være.

| Verdi | Virkning |
| --- | --- |
| `on` (standard) | Viseren leser `#side=` ved oppstart og holder adressen oppdatert mens leseren blar. |
| `off` | Viseren lar adressen være helt i fred, og åpner alltid på forsiden. |

Standarden er `on`: delbare lenker er det de fleste vil ha, og de virker uten at du gjør noe. Bruk `deep-link="off"` når nettsiden selv bruker `#`-adressen til noe annet, for eksempel faner eller en side som ruter med `#`. Med flere visere på samme side kan du slå av den første for å la en senere følge adressen.

### Høyde

Viseren setter sin egen høyde ut fra bredden og det den viser: lav og bred for oppslag, høy for enkeltsider, aldri mer enn 88 % av skjermhøyden. Da flyter ikke oppslaget i et tomt felt på mobil. Setter du selv en høyde på elementet, for eksempel `style="height:80vh"`, brukes den i stedet. Da kan det bli tom plass over og under et oppslag på smale skjermer. Scriptet kan lastes én gang per side, også ved flere visere. Komponenten bruker Shadow DOM for å isolere stilene fra Webflow.

### Hendelser

Viseren sender tre hendelser fra `<e-brosjyre>`-elementet. Bruk dem for eksempel til å måle hvor langt folk faktisk leser.

| Hendelse | Når | `detail` |
| --- | --- | --- |
| `brochure-ready` | Én gang når PDF-en er lastet og de første sidene vises. | `{ page, pages, total }` |
| `brochure-page` | Hver gang leseren lander på et nytt oppslag, også det første. Sendes når bladet har landet, ikke underveis i en vending, og bare én gang for det samme oppslaget. Zoom og endret vindusstørrelse sender ingenting så lenge de samme sidene vises. | `{ page, pages, total }` |
| `brochure-error` | Når PDF-en ikke kan åpnes. | `{ message }` |

`page` er første side i oppslaget som vises, `pages` er sidene som faktisk vises (én eller to, for eksempel `[6, 7]`), og `total` er antall sider i PDF-en. `message` er feilmeldingen leseren ser.

```html
<script>
  const brosjyre = document.querySelector('e-brosjyre');
  brosjyre.addEventListener('brochure-ready', e => console.log(`Lastet: ${e.detail.total} sider`));
  brosjyre.addEventListener('brochure-page', e => {
    const sist = Math.max(...e.detail.pages);
    console.log(`Leser side ${e.detail.pages.join('–')} av ${e.detail.total}`);
    // For eksempel: gtag('event', 'brosjyre_side', { side: sist, av: e.detail.total });
  });
  brosjyre.addEventListener('brochure-error', e => console.warn(e.detail.message));
</script>
```

Legg scriptet etter `<e-brosjyre>` i samme Code Embed, eller i sidens egendefinerte kode før `</body>`. Hendelsene bobler ikke ut av en iframe; bruk direkte innbygging hvis du vil lytte på dem.

Demoens **Bruk på din nettside** lager en kopierbar kode fra dine URL-er. Lokale adresser som `localhost` fungerer bare på din maskin og skal erstattes med offentlige HTTPS-adresser før publisering.

### Alternativ: iframe

Hvis du foretrekker en iframe, bruk `viewer.html` fra publiseringspakken på din egen filvert. jsDelivr leverer HTML-filer som ren tekst, så iframe-varianten virker ikke derfra. `pdf`-parameteren (alias `src`) må URL-kodes (i JavaScript: `encodeURIComponent(pdfURL)`). `spread`, `chrome` og `deep-link` virker som attributtene over. Legg `#side=7` til slutt i adressen for å åpne på en bestemt side. Inne i en iframe følger viseren sin egen adresse, ikke nettsidens: adressen leseren deler, får ikke med seg sidetallet. Vil du ha delbare lenker til sider, bruk direkte innbygging. En iframe kan ikke endre sin egen høyde, så gi den en høyde som følger bredden. `aspect-ratio:6/5` passer omtrent for stående A4-oppslag. Eksempel:

```html
<iframe
  src="https://DIN-VISERVERT.no/viewer.html?pdf=https%3A%2F%2FDIN-PDFVERT.no%2Fbrosjyre.pdf&spread=always"
  title="Vår brosjyre"
  style="width:100%;aspect-ratio:6/5;max-height:88vh;border:0"
  allow="fullscreen"
  allowfullscreen
  loading="lazy"
></iframe>
```

## Størrelsen på PDF-en avgjør ventetiden

Hele PDF-en lastes ned før første side vises. Nettleseren får ikke lese `Accept-Ranges` fra en
annen kilde, så PDF.js kan ikke hente bare de sidene leseren trenger når filen ligger på et
annet opphav enn nettsiden. Filstørrelsen er derfor den viktigste enkeltfaktoren for hvor
lenge leseren venter.

Målt på en Pixel 7-profil med CPU strupet 4x, median av tre kjøringer, tid til første side:

| Nettverk | 7 KB | 3,9 MB | 2,3 MB (samme katalog, web-eksport) |
| --- | --- | --- | --- |
| Rask 4G (8,1 Mbit/s) | 1,4 s | 5,7 s | 4,1 s |
| Treg 4G (1,44 Mbit/s) | 5,4 s | 29,1 s | 20,0 s |
| 3G (0,4 Mbit/s) | 18,9 s | 104 s | — |

**Eksporter for skjerm, ikke for trykk.** En trykkeri-PDF bærer med seg ting som ikke gjør
nytte på nett: CMYK-bilder, innebygde ICC-profiler (en fargeprofil alene kan være rundt
500 KB), skjæremerker og bilder i 300 dpi. I Acrobat heter det «Reduser filstørrelse» eller
«Lagre som annet → Optimalisert PDF»; i InDesign er det eksportforvalget «[Minste filstørrelse]»
med RGB-farger og bildeoppløsning rundt 150 dpi. Sikt mot **under 2 MB** for en brosjyre som
skal leses på mobil.

Går filen ikke under uten at kvaliteten ryker, er det bedre å dele den i flere kortere
brosjyrer enn å la leseren vente.

## Hosting og CORS

- **PDF:** Når PDF-en ligger på et annet opphav enn nettsiden, må PDF-verten sende `Access-Control-Allow-Origin` med nettsidens opphav eller `*`. I iframe-varianten er det viservertens opphav som må tillates. Dette avgjøres av filvertens respons, ikke av en innstilling i viseren. Test den konkrete Webflow Assets-lenken på den publiserte siden.
- **Viserfiler:** For direkte innbygging fra en annen vert må også `ebrosjyre.js` og PDF.js-ressursene tillate CORS. Bruk riktig MIME-type: JavaScript-filer (`.js` og `.mjs`) som `text/javascript`, `.wasm` som `application/wasm`.
- **HTTPS:** Bruk HTTPS til både viser og PDF når nettsiden har HTTPS.
- **Innholdspolicy:** Hvis nettstedet har CSP, må den tillate viserens script, PDF-henting, PDF.js-fontene og arbeideren. En arbeider fra en annen vert kan kreve `worker-src blob:`. Konfigurer dette på nettstedet der policyen settes.
- **Ingen mellomtjener:** Viseren omgår ikke CORS og sender ikke PDF-en gjennom en tredjepart. Nettleseren henter filene direkte.

En respons som viser CORS-tilgang kan kontrolleres med:

```sh
curl -I -H 'Origin: https://DIN-NETTSIDE.no' 'https://DIN-PDFVERT.no/brosjyre.pdf'
```

Hvis viseren viser en feil, kontroller offentlig tilgang, CORS, at lenken returnerer PDF-data og at PDF-en ikke har passord. **Åpne original PDF** gir direkte tilgang til filen når URL-en er gyldig.

## Leserfunksjoner

- Bokmodell: forside alene, deretter doble oppslag og siste side alene. Oppslag også på mobil som standard; `spread="auto"` gir enkeltsider når en side ville fått under rundt 230 px, og `spread="single"` gir alltid enkeltsider. Rammen tilpasser høyden til det som vises.
- Navigasjon med knapper, piltaster, Home/End, sidelinje og dra-blaing med mus eller finger: bladet følger draget som papir som vendes om ryggen, et raskt flikk fullfører vendingen, et kort og langsomt drag faller tilbake, og første/siste side gir gummistrikk-motstand. Bladet vendes i 3D om ryggen med skygge i bretten, og arket bøyer seg litt underveis: nesten flatt mot siden, tydeligst når det står på høykant, og mer ved et raskt drag enn et rolig. Med redusert bevegelse holdes arket rett. Bladet tegnes med WebGL som én sammenhengende flate med lys som følger bøyen, så arket ikke får synlige skjøter i noen nettleser (heller ikke Safari). Uten WebGL skifter sidene uten synlig blad. Raske gjentatte sveip eller klikk legger flere blad i lufta samtidig, så du aldri venter på forrige vending; et drag mot et blad i fart griper det og snur det.
- Zoom 100–300 % relativt til tilpasset side. Knip med to fingre på brosjyren for å zoome jevnt om punktet mellom fingrene (nettsiden selv zoomes ikke), eller dobbelttrykk/dobbeltklikk for å zoome inn til 200 % om trykkpunktet og ut igjen. Pluss- og minusknappene og tastene + og − zoomer i steg på 25 % om midten. I forstørret side flytter én finger eller et musedrag bildet, med fart som ebber ut etter et raskt drag, uten å bla. Klikk prosenttallet for å tilpasse på nytt. Zoom nullstilles ved sidebytte.
- Berøringsmålene er minst 44 × 44 px, også pilene på telefon, som ser ut som før, men tar imot trykk over et større felt.
- Fullskjerm på nettlesere og innbygginger som støtter/tillater det. Knappen skjules når funksjonen ikke er tilgjengelig.
- Tekstlag: PDF-ens egen tekst ligger usynlig over hver side, nøyaktig der ordene er tegnet. Med mus eller penn markerer du tekst ved å dra over den og kopierer som vanlig; et drag som starter utenfor teksten blar. På berøringsskjerm blar et sveip også over tekst, og et langt trykk markerer. Skjermlesere leser sideteksten i stedet for et bilde av siden. Mens et blad vendes, er tekstlaget borte, og det kommer tilbake når bladet har landet.
- Lenker i PDF-en er klikkbare. Nettlenker (`http`, `https`) åpnes i ny fane med `rel="noopener noreferrer"`, `mailto`-lenker åpner e-postprogrammet, og lenker til en side i samme PDF blar dit. Andre lenketyper, som `javascript:` og `file:`, blir ikke klikkbare.
- Innholdsoversikt fra knappen ved sidelinjen: PDF-ens egne bokmerker som en liste med kapitler og sidetall der PDF-en har dem, ellers små bilder av alle sidene. Bildene tegnes i lav oppløsning og etter hvert som de rulles fram, så også en katalog på 60 sider åpner uten å henge. Listen rulles med fingeren, og med tastaturet flytter piltastene mellom oppføringene, Enter hopper dit og Escape lukker. Oversikten finnes ikke med `chrome="none"`. Lag bokmerker i PDF-en (i InDesign: «Bokmerker»-panelet, eller eksporter med «Opprett PDF-bokmerker» fra innholdsfortegnelsen) for å få navngitte kapitler.
- Delbare lenker til en side (`#side=7`) som følger leseren uten å fylle historikken, og hendelsen `brochure-page` ved hvert sidebytte.
- Tre rammevarianter med `chrome`: full mørk boks, gjennomsiktig med knapper, eller bare boken.
- Flere uavhengige visere på samme side; `src` kan endres dynamisk.
- Lastestatus, feilbeskjeder, tastaturfokus og redusert bevegelse.

Sidene tegnes til canvas med tekstlaget over. Tekstlaget finnes bare for oppslaget som vises og nabooppslagene, så nettleserens egen søkefunksjon finner ikke tekst lenger ut i brosjyren. Viseren har heller ingen egen søkefunksjon. Sider uten tekst i PDF-en (for eksempel skannede bilder) har ikke noe å markere, og skjermlesere får bare vite at siden mangler lesbar tekst. Tekstlaget følger rekkefølgen i PDF-en, så en korrekt tagget PDF gir den beste opplesningen. Skjemafelt er ikke interaktive. Passordbeskyttede filer støttes ikke, og det er ingen innholdsredigering.

## Utvikling og verifisering

```sh
npm run check
npx playwright install chromium
npm test
```

Nettlesertestene dekker oppslag, siste side, enkeltsider og liggende PDF-er, `spread`-verdiene og rammens høyde på telefon, tastatur, sveiping, zoom med knip og dobbelttrykk på ekte enhetsprofiler (iPhone 15 stående og liggende, iPad, Galaxy S9+) i både Chromium og WebKit, berøringsmål, størrelsesendring, feil og gjenoppretting, raske kildebytter, flere komponenter, URL fra et annet opphav, direkte innbygging, iframe og fullskjerm. Skjermbilder skrives til `test-results/`.

- `src/viewer.js` / `src/viewer.css`: HTML-komponenten og isolerte stiler.
- `public/`: demo, kodegenerator, iframe-side og kort oppsettsveiledning.
- `scripts/build.mjs`: bundler komponenten og kopierer PDF.js med ressurser.
- `scripts/demo-pdf.mjs`: lager eksempel-PDF-en lokalt; ingen ekstern bildeavhengighet.
- `tests/`: Playwright-tester.

Etter endringer: bygg på nytt og oppdater forhåndsvisningen. Utviklingsserveren kjører det sist bygde innholdet.

## Gi ut en ny versjon

`dist/` er sjekket inn, fordi jsDelivr leverer filene slik de ligger i repoet på taggen.

```sh
npm version minor --no-git-tag-version   # eller patch/major; oppdaterer package.json
npm test                                 # bygger dist/ på nytt og kjører testene
git add -A && git commit -m "v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push origin main --tags
```

Ny adresse blir `https://cdn.jsdelivr.net/gh/SimonKefas/e-brosjyre@vX.Y.Z/dist/ebrosjyre.js`. Flytt aldri en tagg som allerede er pushet: jsDelivr mellomlagrer taggede filer permanent, og sider som bruker den gamle taggen fortsetter uendret til du bytter versjonen i innbyggingskoden.

## Lisens og kilder

Prosjektkoden og eksempel-PDF-en er tilgjengelige under MIT-lisensen. PDF-rendering bruker **PDF.js 6.3.289**, distribuert under Apache-2.0 med tilhørende tredjepartslisenser; disse følger ressursmappene i `dist/pdfjs/`. Avhengighetene er låst i `package-lock.json`.

- [PDF.js: rendering-eksempler](https://mozilla.github.io/pdf.js/examples/)
- [PDF.js: URL-er, CORS og ressursinnstillinger](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
- [Webflow: Code Embed og plantilgang](https://help.webflow.com/hc/en-us/articles/33961332238611-Custom-code-embed)

## Kvalitetskriterier

Disse kriteriene beskriver ønsket resultat og beholdes for manuell gjennomgang. Kais automatiske verifisering kjører bare de mekaniske sjekkene; beståtte tester er ikke en registrert brukergodkjenning av designet.

- En offentlig PDF-URL kan konfigureres enkelt uten konto eller egen backend; krav til filvertens CORS-støtte forklares i veiledningen.
- Viseren har mørk bakgrunn, bokmodell med forsiden alene, to og to sider i oppslag og siste side alene, også på mobil som standard (`spread` velger alltid én side eller én side kun på smale skjermer), samme skala gjennom hele dokumentet, og sideskift som et blad som vendes i 3D (sidenes faktiske format og rotasjon styrer plass og skala), blaing med knapper/tastatur/dra, sidetall, zoom og fullskjerm der nettleseren støtter det.
- En fungerende demo, kopierbar Webflow-innbygging og kort norsk veiledning er levert; løsningen krever ikke en betalt brosjyretjeneste.
- Lasting, ugyldig URL og utilgjengelig PDF håndteres tydelig, og viseren er verifisert på desktop- og mobilstørrelse.
