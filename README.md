# discord-telegram-watcher

Ever keep a Discord channel open just to catch the next post? This script does the watching for you. When someone posts in the channel, you get a message on Telegram.

It's one Node.js file with no dependencies. Every minute, a bot you own checks the channel and forwards anything new to your Telegram chat. On Windows there's an installer that makes it start on its own at boot, so you set it up once and forget about it.

```
Discord channel  ->  your private bot (checks every 60s)  ->  Telegram message
```

An alert looks like this:

> **Sender name**
> The message text, plus any embed text and attachment links

## What it does well

- **Stays quiet about the past.** On first run it skips everything already in the channel, so you won't get a flood of old messages.
- **Never repeats itself.** It remembers the last message it handled, so a restart or reboot picks up where it left off, without duplicates and without gaps.
- **Filters.** Give it a list of keywords and it only pings you for those. You can also tell it to ignore bots and webhooks.
- **Reads embeds.** A lot of bots post their content inside embeds. The title, description and fields all come through, so alerts aren't blank.
- **Tells you when it breaks.** If something goes wrong, you get a Telegram message, at most once an hour so it can't spam you.
- **Handles Discord rate limits** by waiting and trying again.

## What it doesn't do

- It watches one channel per copy. For more channels, run more copies (see "How it works" below).
- It isn't instant. You'll see alerts within one polling interval, a minute by default.
- It never posts to Discord. It only reads.

## What you'll need

- A computer that stays on. The installer is for Windows, but `watcher.js` runs anywhere Node does.
- [Node.js](https://nodejs.org) 14 or newer. The LTS version is fine. Type `node --version` to see if you already have it.
- Permission to add a bot to the Discord server (the Manage Server permission).
- The Telegram app on your phone.

## Setup

There are three steps: a Discord bot, a Telegram bot, then the install. About 15 minutes in total.

### Step 1: Make a private Discord bot

1. Go to <https://discord.com/developers/applications> and click **New Application**. Call it anything you like.
2. Open the **Installation** tab and set **Install Link** to **None**. Save. (Do this first. Discord won't let you make the bot private otherwise.)
3. Open the **Bot** tab. Switch **Public Bot** off and leave **Require OAuth2 Code Grant** off. Save. Now only you can add this bot to servers.
4. Still on **Bot**, click **Reset Token** and copy it somewhere safe. That's your `DISCORD_BOT_TOKEN`. Treat it like a password, because anyone who has it controls the bot.
5. Still on **Bot**, scroll down and turn on **Message Content Intent**. Save. If you skip this, alerts show up with no text in them.
6. Go to **OAuth2 > URL Generator**. Tick `bot`, then tick **View Channels** and **Read Message History**. That's all it needs.
7. Open the link it generates, pick your server and click **Authorize**.
8. In Discord, turn on Developer Mode (Settings > Advanced). Then right-click the channel you want to watch and choose **Copy Channel ID**. That's your `DISCORD_CHANNEL_ID`.
9. If the channel is limited to certain roles, make sure the bot's role can view it and read its history.

One warning: use a bot token, never your personal account's token. Using a personal token breaks Discord's rules and can get your account banned.

### Step 2: Make a Telegram bot

1. In Telegram, open **@BotFather** and send `/newbot`. Answer its questions and it hands you a token. That's your `TELEGRAM_BOT_TOKEN`.
2. Open your new bot and send it any message. "hi" works. This is how the setup finds your chat ID later.

### Step 3: Install it

**On Windows (the easy way).** Download or clone this repo. Open PowerShell as Administrator in the repo folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Here's what happens:

1. It copies `watcher.js` to `C:\discord-watcher`. (Want it somewhere else? Add `-InstallDir` and a path.)
2. Notepad opens `config.env`. Fill in the three values from above and leave `TELEGRAM_CHAT_ID` empty for now.
3. It looks up your Telegram chat ID and prints it. Paste it into `config.env` when Notepad opens again.
4. It tests Discord and Telegram. Your phone gets "Check OK". If anything fails, nothing gets installed and you'll see what went wrong.
5. It sets up a Scheduled Task called `DiscordWatcher` that starts at boot, then starts it. You'll get "Discord watcher is live" on Telegram.

You can re-run the installer any time. It keeps your `config.env` and your place in the channel.

**On any other system, by hand.**

```bash
cp config.env.example config.env     # then open config.env and fill it in
node watcher.js --find-chat          # prints your TELEGRAM_CHAT_ID, paste it into config.env
node watcher.js --check              # tests Discord and Telegram
node watcher.js                      # runs the watcher
```

To keep it running on Linux or macOS, put `node watcher.js` under systemd, pm2 or launchd. I haven't included service files for those.

## Settings

Everything lives in `config.env`, next to `watcher.js`. One `KEY=value` per line, no quotes.

| Setting | Needed? | What it does |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | Your bot's token from the Developer Portal |
| `DISCORD_CHANNEL_ID` | yes | The channel to watch |
| `TELEGRAM_BOT_TOKEN` | yes | The token from @BotFather |
| `TELEGRAM_CHAT_ID` | yes | Where alerts go. `--find-chat` finds it for you |
| `KEYWORDS` | no | Words to watch for, separated by commas, like `restock,preorder`. Not case sensitive. Leave it empty to get every message |
| `IGNORE_BOTS` | no | Set to `true` to skip messages from bots and webhooks. Default is `false` |
| `POLL_SECONDS` | no | How often to check, in seconds. Default 60, minimum 10 |

On Windows, changes only take effect after a restart:

```powershell
Stop-ScheduledTask DiscordWatcher; Start-ScheduledTask DiscordWatcher
```

## Day to day on Windows

Run these in PowerShell as Administrator.

| What you want | Command |
|---|---|
| Watch the log live | `Get-Content C:\discord-watcher\watcher.log -Tail 30 -Wait` |
| Check that it's running | `Get-ScheduledTask DiscordWatcher` |
| Restart it | `Stop-ScheduledTask DiscordWatcher; Start-ScheduledTask DiscordWatcher` |
| Uninstall, keep your files | `powershell -ExecutionPolicy Bypass -File .\uninstall.ps1` |
| Uninstall and delete everything | `powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveFiles` |

## When something goes wrong

| What you see | What it usually means | What to do |
|---|---|---|
| Discord 401 | The token is wrong or out of date | Reset it in the Developer Portal and update `config.env` |
| Discord 403 | The bot isn't in the server, or can't see the channel | Go back over Step 1, points 6 to 9 |
| Discord 403 with code `40333` | Discord's Cloudflare layer blocked the request. It's usually the network or IP being blocked, not your setup | Run it from a different server or network. This was seen when calling the API from Google Apps Script |
| Discord 404 | Wrong channel ID | Copy it again |
| Telegram 400, chat not found | You haven't messaged your bot yet, or the chat ID is wrong | Send the bot a message and run `--find-chat` again |
| Alerts arrive with no text | Message Content Intent is off | Step 1, point 5 |
| `node` is not recognized | Node.js isn't installed, or isn't on your PATH | Install the LTS version and reopen PowerShell |
| Every alert arrives twice | Two copies are running, for example the task plus a Startup-folder shortcut | Keep only one way of starting it |

## How it works

It asks the Discord REST API for new messages every `POLL_SECONDS` seconds. That's why alerts can lag by up to one interval. It doesn't use Discord's gateway.

It saves the ID of the last message it handled in `state.json` and only asks for newer ones. That ID moves forward only after Telegram accepts the message, so if Telegram fails, the message gets retried instead of lost.

Want to watch several channels? Make a separate folder for each one, with its own `config.env`, and give each its own task name (`install.ps1` takes a `-TaskName` and an `-InstallDir`).

## Keep your tokens safe

`config.env` holds your tokens. It's in `.gitignore` so Git won't pick it up, but don't commit it, share it or screenshot it either. On Windows the installer locks the file down to your account, SYSTEM and Administrators.

If a token leaks, reset it right away. For Discord, use the Developer Portal. For Telegram, send `/revoke` to @BotFather.

## License

MIT. See [LICENSE](LICENSE).
