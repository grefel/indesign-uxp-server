# Artwork-Layout: Modell, Bildanalyse, Bewertung, Solver

Technische Beschreibung der Layout-Werkzeuge, die für das Projekt `artworker` (Nachbar-Repo) entstanden sind. Projektstand, Entscheidungen und nächste Schritte stehen dort in `HANDOVER.md` und `roadmap.md`. Stand: Commit `71604e9`, PoC.

## Überblick

```
InDesign ──(1 Roundtrip)──▶ Layout-Modell + Text-Messtabellen     get_layout_model / measure_text_table
Bilddatei ──(Node, sharp)──▶ Motivmaske + Bildmerkmale (Cache)    analyze_image_free_space / analyze_image_features
                      Node ▶ Kandidaten erzeugen → harte Regeln → Score → diverse Top N   layoutSolver.js + layoutScore.js
Node ──(1 Roundtrip)──▶ Ebenen anlegen, nachmessen, abgleichen    artwork_apply
InDesign ──(1 Roundtrip)──▶ Ebenen-PNGs → Kontaktbogen (sharp)
```

Die Logik liegt in **reinen Node-Modulen** ohne I/O und ist offline testbar. Die Handler bauen UXP-Code-Strings, führen sie über den `ScriptExecutor` aus und rechnen in Node weiter.

## Module (`src/utils/`)

| Modul | Aufgabe |
|---|---|
| `layoutModel.js` | Projekt-Konfiguration finden, laden, mischen, prüfen (`findConfigFile`, `loadConfig`, `validateConfig`); Rollen-Zuordnung (`matchRole`); Format mit Seitenrändern, Modulen und Bildanschnitt (`buildFormat`); erlaubte Schriftgrade (`planPointSizes`); Polygon-Hilfen; Kompaktierung der Messtabellen |
| `textSnippets.js` | UXP-Snippets zum Lesen von Zeilen per `everyItem()` (`TEXT_HELPERS`) und zum Auflösen von Textrahmen |
| `imageMask.js` | Bild laden (`loadGray`, sharp), Motivmaske im Raster (`buildMask`, Schwelle Weiß, `fillHoles`), Sidecar-Cache `<bild>.freespace.json` (`getMotifMask`), Platzierung in Seiten-mm (`placementFromGeometry`, `placeMask`), Umriss je Zeile (`rowSpans`), freie Rechtecke, Kollision und Abstand (`checkRect`, `rectDistance`), Auflösung (`resolutionInfo`) |
| `imageFeatures.js` | Schwerpunkt, Saliency-Fokus mit Region und safeCrop, Hauptachse (PCA), Standlinie (untere Tangente), Kanten (Sobel + Hough), harte Außenkanten, Blickrichtung; Umrechnung in Seiten-mm (`placeFeatures`); Kurzfassung für das Modell (`featureSummary`) |
| `layoutScore.js` | Bewertung einer **Szene**: harte Regeln (`checkHardRules`) und Score (`scoreScene` = `scoreLayout`); Bilddaten für neue Geometrie (`placeImageData`); Original-Paarung für H4 (`originalPairing`, Skriptlabel `artworkSource`); Defaults `SCORING_DEFAULTS` |
| `layoutSolver.js` | Messplan und Pakete (`planMeasureJobs`, `batchJobs`), Textvarianten, Bild-Setups (`imageSetups`, prüft `minMotifVisible`), Kandidaten je Setup, Vorfilter, Szenenbau (`buildScene`), Bewertung, Merkmals-Distanz (`layoutFeatures`, `layoutDistance`), diverse Auswahl (`selectDiverse`), Polygon-Jobs, Spezifikation zum Anwenden (`toSpec`, `validateSpec`, `compareApplied`); Defaults `SOLVER_DEFAULTS` |

## Tools

| Tool | Zweck | Roundtrips |
|---|---|---|
| `get_layout_model({ pageIndex, layer?, configPath? })` | Format, aufgelöste Konfiguration (mit Quelle), Rollen/Rang/Lesereihenfolge/erlaubte Änderungen, Items mit Form, Stil und Schrift-Metriken, Bild-Basisdaten (+ gecachte Bildmerkmale) | 1 |
| `measure_text_table({ itemId, widths, pointSizes?, hyphenation? })` | Breiten × Schriftgrade × Trennvarianten; Spalten `[w, pt, hyph, lines, top, h, fb, lb, maxW, lastRel, hyphens, dashStarts, rag, overset]`; max. 240 Kombinationen | 1 |
| `measure_text_in_shapes({ itemId, shapes, pointSize?, hyphenation? })` | Text in Polygone laufen lassen (temporäres Duplikat, `entirePath`); max. 40 Umrisse | 1 |
| `analyze_image_free_space({ itemId, grid, whiteThreshold, occupiedRatio, fillHoles, useCache })` | Maske, Motiv-BBox, sichtbarer Anteil, Umriss je Zeile, 3 größte freie Rechtecke, max. Skalierung bei 200 dpi | 1 |
| `analyze_image_features({ itemId, whiteThreshold, axisTolerance, maxEdges, useCache })` | Fokus, safeCrop, Hauptachse, Standlinie, Kanten, Außenkanten, Blickrichtung | 1 |
| `check_motif_collision({ imageItemId, itemIds?, rects?, minGap })` | Textzeilen bzw. Rechtecke gegen das Motiv | 1 |
| `score_layout({ layers, pageIndex, configPath?, detail })` | Ebenen einlesen und bewerten (valid, Score, S1–S10, Verstöße) | 1 |
| `artwork_solve({ pageIndex, sourceLayer?, count, apply, preview, layerPrefix, previewDir, previewDpi, returnCandidates, configPath, seed, dumpPath })` | kompletter Lauf | 7 |
| `artwork_apply({ candidates, layerNames, configPath? })` | Kandidaten anwenden, nachmessen, Abweichungen melden | 1 |
| `duplicate_items_to_layer`, `export_layer_preview` | Ebenen-Hilfen | 1 |

Kandidaten-Format (serialisierbar): `texts: [{ id, role, frame, shape?, pointSize, leading, leadingAuto, hyphenation, noBreak?, predicted: { lines, firstBaseline, lastBaseline } }]`, `images: [{ id, frame, imageBounds, effPpi, widthMm, motifVisible }]`, dazu `topology`, `score`, `breakdown`, `params`.

## Szene (Eingabe der Bewertung)

```
{ format, config,
  elements: [{ id, role, frame:[t,l,b,r], overset?, align?,
               lines:[{ top, bottom, baseline, x, width, text, hyphenated?, paragraphEnd? }],
               style:{ size, leading, font?, fontStyle?, color?, ink?, accent?, capHeight?, ascGlyph?, descGlyph? },
               original? }],
  images:   [{ id, role?, frame, imageBounds, effPpi?, motifRects?, motifFullArea?, features?, ink?, frameVisible? }] }
→ { valid, violations:[…], skipped:[…], score, breakdown:{ S1..S10:{ v, w, note } }, detail? }
```

Alle Längen in mm, Seitenkoordinaten, Rechtecke `[top, left, bottom, right]`. Eine Bewertung dauert etwa 0,4 ms.

## Regeln und Kriterien

**Harte Regeln** (einzeln abschaltbar unter `scoring.rules`): H1 Übersatz · H2 Text im Satzspiegel (Zeilenbox) · H3 Preis einzeilig · H4 nur erlaubte Stiländerungen gegenüber dem Original · H5 ≥ minPpi · H6 Blitzer, nur an sichtbaren Bildkanten · H7 safeCrop sichtbar · H8 Text ↔ Motiv · H9 Textüberlappung (Glyphen-Boxen) · H10 Strich am Zeilenanfang, kurze Trennung · H11 Lead-Rolle (Headline) zuerst · H12 sichtbarer Motivanteil ≥ `minMotifVisible`.

**Score** (Gewichte unter `scoring.weights`): S1 Ausrichtung (bündige Kanten je Element und Achse auf gemeinsamen Linien, Ruhe über Zahl der Fluchtlinien, Abzug für Beinahe-Treffer, Bonus für Wunsch-Ausrichtungen) · S2 Abstands-Rhythmus (Modul) · S3 Gruppierung · S4 Hierarchie (Rangkorrelation optisches Gewicht ↔ Rang) · S5 Balance (Ellipse um die Seitenmitte) · S6 Weißraum (eingeklemmte Lücken, größtes Loch) · S7 Bildanteil (gleitend ab 5 %) · S8 Typografie · S9 Lesefluss (Z-Muster, `readingOrderFlexible`) · S10 Blickrichtung. Fehlen Daten, ist ein Kriterium `null` und fällt aus der Gewichtssumme.

## Konfiguration (`artwork.config.json`)

Suche: Parameter `configPath` → Ordner des Dokuments und Elternordner → Env `ARTWORK_CONFIG` → eingebaute Defaults. Schlüssel: `imageBleed`, `minPpi`, `edgeTolerance`, `allowMotifCut`, `minMotifVisible`, `spacing`, `sourceLayers.exclude`, `hyphenation`, `roles` (Rang, `readingOrder`, `readingOrderFlexible`, `allow`), `match` (geordnete Erkennungsregeln), `scoring` (Regeln, Gewichte, Parameter je Kriterium), `solver` (überschreibt `SOLVER_DEFAULTS`, z. B. `diversity`). Kommentare stehen in `$…`-Schlüsseln.

## Bridge, Plugin und Dialog-Schutz

- `ScriptExecutor.executeViaUXP` kapselt jeden Aufruf mit `wrapWithDialogGuard`: `userInteractionLevel = NEVER_INTERACT`, Rückstellung im `finally`. Bei `ECONNRESET` wird einmal neu verbunden.
- Das Plugin (`plugin/index.js`, Version 1.1.0) unterdrückt Dialoge zusätzlich und verwirft Aufträge, deren Frist abgelaufen ist.
- Die Bridge (`bridge/server.js`) meldet einen Timeout als vermutlich offenen Dialog, merkt sich die Blockade und prüft vor weiteren Aufrufen 3 s lang; `/status` zeigt `busy`, `blocked`, `plugin`, mit `?probe=1` zusätzlich `responsive`.
- Nach Änderungen an Bridge oder Plugin: Bridge neu starten bzw. Plugin im UXP Developer Tool neu laden. Nach Änderungen an `src/`: MCP-Server neu verbinden.

## Tests

`node tests/<datei>.js` – alle offline:

| Test | Inhalt |
|---|---|
| `test-layout-model.js` | Konfiguration, Rollen, Tabellen, Polygone |
| `test-image-mask.js` | Maske, Platzierung, Kollision (löscht den Sidecar-Cache des Testbilds) |
| `test-image-features.js` | synthetische Bilder und Testbild aus `artworker` |
| `test-layout-score.js` | jede Regel H1–H12, jedes Kriterium S1–S10 |
| `test-layout-solver.js` | Generator, Anker, Auswahl, Vielfalt (deterministisch per `seed`) |

Die übrigen Tests in `tests/` laufen live gegen das aktive Dokument und verändern es.

## Grenzen

- Bildanalyse setzt Freisteller auf Weiß voraus. Bei randvollen Fotos gilt das ganze Bild als Motiv, Standlinie und Außenkanten sind bedeutungslos.
- Gedrehte Bilder und Textrahmen werden nur gewarnt bzw. abgelehnt.
- Messung kostet etwa 50 ms pro Probe; höchstens 60 Proben pro Skript (`solver.measure.maxProbesPerScript`), sonst drohen Bridge-Timeouts und InDesign-Hänger.
