# 0027 — User data terminates; systemd owns the process

**Status:** Accepted
**Date:** 2026-09-14

## Context

The obvious way to end a boot script is to start the server:

```bash
node /opt/app/server.js
```

It works, in the sense that the application serves traffic. It is wrong in three ways, and none
of them produces an error.

### cloud-init never returns

The script is the last thing cloud-init runs. A foreground process means that step never
completes, so cloud-init never reports finished. Today nothing asks. In layer 5 something will:
an auto scaling group with a creation policy waits for a signal that, in this arrangement, cannot
arrive — and the failure surfaces as a stack that sits in `CREATE_IN_PROGRESS` until it times out,
pointing at an auto scaling group rather than at a boot script.

### The process dies with its session

A process started from a shell that then exits can take `SIGHUP` with it. The instance stays up,
SSH works, everything looks healthy from the outside, and nothing is listening on 8080. This is
the zombie-instance failure, and it is unpleasant precisely because the instance is fine — it is
only the application that is gone.

### Nothing restarts it

A crash is permanent until someone notices. The target goes unhealthy, the balancer stops routing
to it, and with a single instance per tier that is the tier down. Nothing brings it back.

### And a fourth thing, which is easy to forget

cloud-init runs `scripts-user` on **first boot only**. A reboot re-runs nothing. So an instance
whose user data has changed is an instance still running whatever it booted with — and this is
the same problem, one level up, as a launch template whose new version does not touch running
instances.

## Decision

**User data writes a systemd unit and starts it, then exits.** It does not run the application.

```
[Service]
ExecStart=/usr/bin/node /opt/app/server.js
Restart=always
RestartSec=2
```

cloud-init completes, so signals work and layer 5 can depend on them. systemd owns the process,
so it survives the session that started it and comes back from a crash. `RestartSec=2` keeps a
crash loop from becoming a busy loop.

**The first-boot-only behaviour is accepted rather than worked around.** cloud-init can be told to
re-run on every boot with `cloud_final_modules: [[scripts-user, always]]`, and that is almost
always the wrong fix — it turns every reboot into a reinstall, which is slower, less predictable,
and dependent on a package repository answering at a moment nobody chose. The right answer to
"the boot script changed" is replacing the instance, which is layer 5's instance refresh.

**User data stays small and idempotent**, and that is a decision made here for layer 5's benefit.
Changing user data produces a new launch template version and does not touch running instances.
Without a rolling replacement the sequence is: edit the boot script, deploy, watch everything go
green, and have every instance keep running the old code — which is among the most disorienting
failures in this area. Replacement is the cure, and replacement only stays affordable if booting
is fast. [ADR-0026](0026-the-application-contract.md)'s zero-dependency rule is half of that
answer already.

## Consequences

**Easier.** The application survives a crash and a closed SSH session. cloud-init finishes, so
layer 5 can use creation policies and signals rather than guessing. `systemctl status app` is a
real answer to "is it running", which a backgrounded process is not.

**Harder.** The boot script now writes a file and talks to a service manager instead of running
one command. More to get right in a place that is hard to debug.

**What it costs.** `Restart=always` hides a crash loop. An application that dies on every request
restarts forever, the target may even flap healthy between restarts, and the only evidence is in
`journalctl`. A supervised process that is broken looks more alive than an unsupervised one that
is broken, which is a real trade and not a free win.

**Where the failures actually surface**, because this is the layer where someone will need it:

| Symptom | Look at |
|---|---|
| Target never turns healthy, instance is up | `/var/log/cloud-init-output.log` |
| Boot is slower than expected | `cloud-init analyze blame` |
| Service is not running | `systemctl status app`, `journalctl -u app` |

None of these is reachable from the console, which is why [ADR-0028](0028-require-imdsv2.md)'s
Session Manager access is not a convenience.

**The guard.** One assertion reads the user data and checks that the systemd unit is written and
that the **last command is not the application**. It is a weak assertion by this repository's
standards — it inspects a string rather than a resource — and it is the only thing standing
between a refactor and a stack that hangs for twenty minutes before failing with a message about
an auto scaling group.

**When this is revisited.** If layer 5's instance refresh proves painful enough that re-running
user data in place becomes tempting. That temptation is what this record exists to argue with.
