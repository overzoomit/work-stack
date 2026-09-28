#!/usr/bin/env python3
"""PTY bridge for Work.

Spawns a shell inside a pseudo-terminal and relays bytes:
  stdin  (fd 0) -> pty master   (keystrokes)
  pty master    -> stdout (fd 1) (terminal output)
  fd 3          -> control lines "cols rows\n" to resize the pty

Usage: pty-helper.py <cols> <rows> <shell> [args...]
Only uses the standard library, so it runs on Linux and macOS as-is.
"""
import errno
import fcntl
import os
import pty
import select
import struct
import sys
import termios

CONTROL_FD = 3


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]

    pid, master = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.environ["TERM_PROGRAM"] = "Work"
        os.execvp(argv[0], argv)

    set_size(master, cols, rows)
    inputs = [0, master, CONTROL_FD]
    control_buf = b""

    while True:
        try:
            ready, _, _ = select.select(inputs, [], [])
        except InterruptedError:
            continue

        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            os.write(1, data)

        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                inputs.remove(0)
            else:
                os.write(master, data)

        if CONTROL_FD in ready:
            data = os.read(CONTROL_FD, 1024)
            if not data:
                inputs.remove(CONTROL_FD)
            control_buf += data
            while b"\n" in control_buf:
                line, control_buf = control_buf.split(b"\n", 1)
                c, r = line.split()
                set_size(master, int(c), int(r))

    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))


if __name__ == "__main__":
    main()
