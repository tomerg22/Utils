# media1

Tools for the home media server media1 (`192.168.0.11`, qBittorrent WebUI on port 8080).

## hebits-add

Runs on the Mac. Adds a HeBits torrent to qBittorrent on media1 from its page URL or its id.

```
hebits-add https://hebits.net/torrents.php?torrentid=130148
hebits-add 130148 133940        # several at once
hebits-add --dry-run 130148     # fetch and show, do not add
hebits-add --tv 130148          # force the category (also --movie)
```

- Needs Python 3 and `curl`. Works only on the home network.
- No keys in the file. It reads `authkey` and `torrent_pass` at run time from a HeBits RSS article that qBittorrent already has.
- TV (SxxEyy or a season pack) goes to category `tv`. Anything else goes to the default save path.
- A torrent that qBittorrent already has is skipped.

Install on the Mac:

```
cp hebits-add ~/.local/bin/hebits-add
echo "alias hebits-add='noglob hebits-add'" >> ~/.zshrc
```

The alias stops zsh from reading the `?` in a pasted URL as a file pattern.

## Not in this folder yet

The Telegram bot `hebits-bot` (`/opt/hebits-bot/bot.py`, systemd service `hebits-bot`) exists only on media1. Its source is not on the Mac.
