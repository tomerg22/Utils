@echo off
REM Turn the TV off (confirmed), then suspend the PC.
REM Bind this to a shortcut / hotkey / voice command instead of using the
REM Start menu's Sleep - see sleep_pc.py for why.
py -3 "%~dp0sleep_pc.py" %*
