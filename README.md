# How fast can audio description be? (HW2, Group 5)

Pilot psychophysics study for *115-1 Human Perceptual-Centric Vision and Multimodal Representation Learning*.
Mandarin audio-description (AD) narration was time-compressed to 24 log-spaced rates (1.0–3.0×) and mixed into the
film soundtrack. Listeners judged content (4AFC), acceptability (yes/no), listening effort (1–5) and speed (5-point JAR),
and set their maximum acceptable rate with a slider.

## Repository layout

| Path | Contents |
|---|---|
| `ad_pipeline/` | Stimulus pipeline and experiment (snapshot of commit `8798da2`). `build_design.py` selects items, synthesises, time-stretches and mixes the stimuli and writes `web/design.json` (the stimulus manifest). `web/` is the experiment website (static page + Vercel functions). `data/` holds the REFRAMED segments, zh-TW translations and item questions. |
| `data/participants.csv` | One row per session: list, device, questionnaire, headphone check, attention check, completion. |
| `data/trials.csv` | One row per trial (practice, main, attention, retest): item, rate (`k`, `rate`, `syl_per_s`), answers and RTs. |
| `data/adjust.csv` | One row per adjustment trial: start level, final level/rate, slider path. |
| `data/make_csv.py` | Builds the three CSVs from the raw server export (the raw export is not included because it contains full browser user-agent strings). |
| `analysis/hw2_analysis.py` | Every number, table and the psychometric figure in the report. |

## Reproducing the analysis

```bash
pip install numpy scipy matplotlib
cd analysis
python hw2_analysis.py --set main   # N = 5, primary analysis (writes results_main.json, figs/fig_psy_main.pdf)
python hw2_analysis.py --set all    # N = 6, sensitivity analysis
```

The full run (2,000 participant-bootstrap resamples) takes a few minutes. `--plot-only` redraws the figure from an
existing results file.

**Sample.** `include = True` in `participants.csv` marks finished sessions. The primary analysis additionally requires
the attention item's content question to be answered correctly (`attention_content_correct = 1`), which excludes one
participant. The headphone check is reported but not used for exclusion (see the report).

**Scales.** `effort`: 5 = no effort, 1 = no meaning understood. `jar`: −2 too slow … 0 just right … +2 too fast.
`content_choice = -1` is "don't know" (scored incorrect). Bins 0–5 in the CSVs are bins 1–6 in the report.

## Stimuli

The rendered stimulus audio (MP3) is shared separately on Google Drive:
https://drive.google.com/drive/folders/1CUeYdgVVzPlxDzwnhxjarVQe5aSC46pC

The excerpts contain film soundtrack from the REFRAMED clips and are shared for course assessment only.
They can be regenerated with `ad_pipeline/build_design.py` from the REFRAMED dataset (AD text CC BY-NC 4.0; clips
obtained with the download method REFRAMED provides).
