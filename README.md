# Everything Fonts Web Font Build

A GitHub Action that builds WOFF2 (and WOFF) files and an `@font-face` stylesheet from the font files in your repository, using [Everything Fonts](https://everythingfonts.com). It never commits anything: it writes to the workspace, and you decide what happens next.

It needs an API key on a paid API plan with conversion. See <https://everythingfonts.com/api>. Store the key as a repository secret named `EVERYTHINGFONTS_API_KEY`.

## Usage

Build the web fonts whenever you publish a release:

```yaml
name: Build web fonts
on:
  release:
    types: [published]
permissions:
  contents: read
jobs:
  webfonts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: everythingfonts/webfont-build-action@v1
        with:
          api-key: ${{ secrets.EVERYTHINGFONTS_API_KEY }}
          sources: fonts/*.ttf
```

### Example: commit the output

The action leaves the files in the workspace. One way to keep them is a commit action such as `stefanzweifel/git-auto-commit-action`. This is only an example; use whatever fits your project. Committing needs `contents: write`.

```yaml
permissions:
  contents: write
jobs:
  webfonts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: everythingfonts/webfont-build-action@v1
        with:
          api-key: ${{ secrets.EVERYTHINGFONTS_API_KEY }}
          sources: fonts/*.ttf
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: Build web fonts
          file_pattern: webfonts/
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | required | Everything Fonts API key (store it as a repository secret). |
| `sources` | required | Glob patterns (one per line or comma-separated) of the font files to convert. |
| `formats` | `woff2` | Comma-separated output formats. |
| `subset` | none | Comma-separated subset preset ids. No subsetting when empty. |
| `output-dir` | `webfonts/` | Directory the built font files are written to. |
| `css-file` | `webfonts/fonts.css` | Path of the generated @font-face stylesheet. |
| `font-display` | `swap` | The font-display value written into the @font-face rules. |
| `api-url` | `https://font.rest/api/v1` | Base URL of the Everything Fonts API. |
| `timeout-minutes` | `10` | Overall time to wait for builds to finish. |

## Outputs

| Output | Description |
|---|---|
| `files` | Newline-separated list of the files that were written. |
| `css-path` | Path of the generated stylesheet. |

## How jobs are counted

Each source font uses one upload job and one kit job. When `subset` is set, each font also uses one subset job. Your API plan's monthly job allowance covers them. If you run out, the step fails with a link to upgrade.

## Pull requests from forks

Workflows triggered by a pull request from a fork do not get repository secrets, so the step fails without a key. Run the action on `push` or `release` instead.

## Privacy

Your fonts are uploaded to Everything Fonts to be converted. The repository is identified only by a SHA-256 hash of its name, never the name itself. The API key is masked and never logged. Output files are written inside the workspace.

## Licence

MIT
