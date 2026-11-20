# GitHub Firehose

A full-screen lobby display of live public GitHub activity: a scrolling feed of pushes, pull requests, issues, reviews and releases from the last hour, plus a side panel of who is doing the work (people, bots, AI agents), what kind of work it is, and the busiest repos.

Built for a 1920×1080 TV; scales to 720p and 4K.

## Run it

Needs Node 20.12 or newer. There is nothing to install.

1. Optional, for about 4× more events: create a fine-grained token at https://github.com/settings/personal-access-tokens/new with **Public repositories (read-only)** and nothing else, then:

   ```
   cp .env.example .env
   ```

   ```
   micro .env
   ```

2. Start the server:

   ```
   node server.mjs
   ```

3. Open http://localhost:8787 and make the browser full screen.

The token stays in `.env` (gitignored) and is only read by `server.mjs`. It is never sent to the browser, put in a URL, or logged.

## URL options

| Option | Effect |
| --- | --- |
| `?demo` | Synthetic events, no server or network needed |
| `?clean` | Hide the details column |
| `?title=...` | Header title |
| `?cta=...` | Call-to-action text in the side panel |
| `?since=5:30pm` | Count events from this time today (default 5:30pm) |

## Keys

- **P**: pause the feed so you can scroll back; press again to resume.
- Click any row to open the commit, PR, issue or comment on GitHub.
