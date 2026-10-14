# Evidence — Module 2: Network ACLs + VPC Flow Logs

**State:** complete. All four experiments measured, infrastructure destroyed and verified empty.

**How it gets filled:** by running [`experiment-runbook.md`](experiment-runbook.md) in order. Each
table here corresponds to a numbered step of that runbook, and the *Step* column says which.

**The rule that makes this worth keeping:** an empty cell is information. A cell filled with what
*should* have happened is not, and six months later it is indistinguishable from a real
measurement. If something was not measured, it says `not measured` and why.

| Field | Value |
|---|---|
| Run date | 2026-10-14 |
| Region | `us-east-1` |
| Account (last 4) | `0731` (identity `user/zevadmin`) |
| CDK version | `2.1141.0 (build c07d251)` — 2.1145.0 was available, not upgraded mid-run |
| `$ME` (client public IP) | `157.100.134.236` |
| `npm test` before deploying | 10 suites, 82 tests, 0 failures |
| `npx tsc --noEmit` | clean |
| `npx cdk synth --strict` | clean for `Net-M1` and `Net-M2` |

---

## 1. The infrastructure, as it landed

One row per `Net-M2` output (`declareOutputs()`, design D7).

| Output | Value | What it is for |
|---|---|---|
| `NetworkAclId` | `acl-09e600e410924d679` | E1 edits this NACL; also the id `describe-network-acls` needs |
| `PublicSubnetIds` | `subnet-08cb7aeefe6d5056a,subnet-0fe48cd93b150f0eb` | The subnets that stopped using the default NACL (G2-07 evidence) |
| `FlowLogId` | `fl-05bc98e5d4b2c33b2` | The flow log the NACL's decisions are measured through |
| `FlowLogGroupName` | `Net-M2-FlowLogsLogGroup9853A85F-22SQhYmrFg7X` | For `aws logs filter-log-events` when reading the evidence back |
| `PublicIngressPort` | **`80`** | Correct: no certificate (ADR-0018) |
| `EphemeralEgressOpen` | `true` | Default branch; E2 sets it to `false` |
| `DeniedSources` | `none` | Empty default at the time of E3 |

And module 1's, which the runbook reuses:

| `Net-M1` output | Value |
|---|---|
| `ExternalUrl` | `http://Net-M1-LoadB-iDEs6WWpjYdD-804104201.us-east-1.elb.amazonaws.com` |
| `FrontendTargetGroupArn` | `…:targetgroup/Net-M1-LoadB-PPZYTC3XCVIN/4b4db84ce29965ea` |
| `BackendTargetGroupArn` | `…:targetgroup/Net-M1-LoadB-ZKVHKT9QLKYR/73ecde7148abf9d2` |
| `FrontendInstanceId` | `i-0516bc8ff8a6c3586` |
| `BackendInstanceId` | `i-077dc32d4adadc5aa` |
| `NatGatewayId` | `nat-0cd7f282e0a212bd5` |
| VPC id (via `describe-stack-resources`) | `vpc-048dace526eca1ff3` |

### Deployment times

| Stack | Resources | Time |
|---|---|---|
| `Net-M1` | 51 | 353.95s deploy, 380.34s total |
| `Net-M2` | 16 | 40.65s deploy, 64.47s total |

`Net-M1` includes the Instance Connect Endpoint's 2m36s, which was the last resource to complete
(10:24:59 → 10:27:35) and blocks nothing the experiments measure.

### Confirmed: what `weak` costs module 1's Outputs

Plan §7 predicted that wiring `Net-M2` to `m1.vpc` would add three plain `Output` entries with no
`Export` key to `Net-M1`. **All three appeared, with the exact names:**

```
Net-M1.PublishOutputRefVpc8378EB385002A76F                    = vpc-048dace526eca1ff3
Net-M1.PublishOutputRefVpcPublicSubnet1Subnet5C2D37C4F5EE3F2D = subnet-08cb7aeefe6d5056a
Net-M1.PublishOutputRefVpcPublicSubnet2Subnet691E08A328131BFA = subnet-0fe48cd93b150f0eb
```

So "module 1 is untouched" is true of its `Resources` and false of its `Outputs`, exactly as
ADR-0032 corrected. Measured, not inferred.

### Unanticipated observation: the deploy pulls the dependency along

`npx cdk deploy Net-M2` printed:

```
Including dependency stacks: Net-M1
...
✅  Net-M1 (no changes)
```

The `addDependency` implicit from the references **does** order a combined operation in the deploy
direction, and the CLI resolves it unprompted. That is the half plan §7 already took as given; the
one still open is the `destroy`, which consults nothing (see §6).

---

## 2. E0 — Baseline

> Taken before `cdk deploy Net-M2`. Valid.

### E0.1 — The default NACL

| Item | Value | Step |
|---|---|---|
| Default NACL's `NetworkAclId` | `acl-0658583ca356c81f9` | E0.1 |
| Entry count | 4 | E0.1 |
| Raw JSON saved to | `module2/e0-default-nacl.json` | E0.1 |

| # | Direction | Action | Protocol | CIDR |
|---|---|---|---|---|
| 100 | ingress | allow | `-1` (all) | `0.0.0.0/0` |
| 32767 | ingress | deny | `-1` | `0.0.0.0/0` |
| 100 | egress | allow | `-1` (all) | `0.0.0.0/0` |
| 32767 | egress | deny | `-1` | `0.0.0.0/0` |

**Exactly as expected, and exactly the SAA-C03 lab's shortcut.** With an `allow all` sitting at
100 in both directions, nothing added below it is ever dead letter and egress is never closed —
the two failures this module builds from scratch in order to reach.

### E0.2 — The associations the deploy replaced

All four of the VPC's subnets were on the default NACL:

| Subnet id | Type | `NetworkAclAssociationId` (before) | Step |
|---|---|---|---|
| `subnet-08cb7aeefe6d5056a` | **public AZ a** | `aclassoc-0d82c4afe0e397d7d` | E0.2 |
| `subnet-0fe48cd93b150f0eb` | **public AZ b** | `aclassoc-0200e38ad4c9d02c7` | E0.2 |
| `subnet-019b53f6d4dd4aba7` | private | `aclassoc-00f91ca1647315909` | E0.2 |
| `subnet-07dd97790eb35dca3` | private | `aclassoc-0a17f311470cc88be` | E0.2 |

The two private ones **stay on the default NACL for the whole experiment**, which is also why
these figures remain a valid "before" for the public path only.

### E0.3 — The three routes, healthy

| Route | `http_code · time_total` | Step |
|---|---|---|
| `/` | `200 · 0.229119s` | E0.3 |
| `/health` | `200 · 0.193903s` | E0.3 |
| `/health/deep` | `200 · 0.216349s` | E0.3 |

`200` on all three. That is what makes any later `000` attributable to the NACL rather than to the
application. `/health/deep` at `0.216s` also confirms the frontend reaches the backend through the
internal balancer (ADR-0029).

### E0.4 — Target health

| Target group | State | Step |
|---|---|---|
| frontend | **`healthy`** | E0.4 |

### E0.5 — ICMP

| Item | Value | Step |
|---|---|---|
| `ping` to the ALB's DNS name | **not measured** — step skipped | E0.5 |

Changes nothing: the row had no measurable target anyway. An ALB does not answer ICMP and both
instances live in private subnets with no public IPv4 (ADR-0012), so from the internet there is
nothing in module 1 that can be pinged.

---

## 3. E3 — Flow logs recording

### E3.1 — The new NACL, as it landed in AWS

Protocol: `6` = TCP, `1` = ICMP, `-1` = all.

| Direction | # | Entry | Action | Proto | Range | Observed | Step |
|---|---|---|---|---|---|---|---|
| ingress | 100 | `AllowPublicPortIn` | allow | 6 | 80-80 | ✅ | E3.1 |
| ingress | 110 | `AllowIcmpIn` | allow | 1 | — | ✅ | E3.1 |
| ingress | 120 | `AllowEphemeralIn` | allow | 6 | 1024-65535 | ✅ | E3.1 |
| ingress | 32767 | AWS implicit | deny | -1 | — | ✅ | E3.1 |
| egress | 100 | `AllowEphemeralOut` | allow | 6 | 1024-65535 | ✅ | E3.1 |
| egress | 110 | `AllowHttpsOut` | allow | 6 | 443-443 | ✅ | E3.1 |
| egress | 120 | `AllowPublicPortOut` | allow | 6 | 80-80 | ✅ | E3.1 |
| egress | 130 | `AllowIcmpOut` | allow | 1 | — | ✅ | E3.1 |
| egress | 32767 | AWS implicit | deny | -1 | — | ✅ | E3.1 |

**All nine entries match plan §3, number for number.** Disjoint bands: no deny above any allow,
and the allows at 100/110/120/130 by declaration index (ADR-0033).

The table above does not cover G2-06: it selects `PortRange`, and ICMP entries carry their type in
`IcmpTypeCode` — hence 110 ingress and 130 egress coming back with `From: None / To: None`. A
second query captures it:

| # | Direction | `IcmpTypeCode` | Expected | Step |
|---|---|---|---|---|
| 110 | ingress | `{"Code": -1, "Type": -1}` | `-1/-1` ✅ | E3.1 |
| 130 | egress | `{"Code": -1, "Type": -1}` | `-1/-1` ✅ | E3.1 |

**G2-06 measured against AWS**, not only against the template. Both directions carry every type
and every code, with neither narrowed to a single type.

> **An instrument finding, not an infrastructure one.** The first attempt at this query used
> `` Protocol==`1` `` and returned `[]`. `Protocol` is a **string** in the EC2 API (`"6"`, `"1"`,
> `"-1"`), and backticks are a JMESPath **numeric** literal: the comparison crosses types, matches
> nothing, and **emits neither error nor warning**. An `[]` that reads exactly like "there are no
> ICMP entries" when there are two. The runbook now carries the correct form (`'1'` single-quoted,
> `--query` double-quoted) with the reason beside it.

Associations, cross-checked against E0.2:

| Subnet id | Before (E0.2) | After | Step |
|---|---|---|---|
| `subnet-08cb7aeefe6d5056a` | `acl-0658583ca356c81f9` (default) | **`acl-09e600e410924d679`** | E3.1 |
| `subnet-0fe48cd93b150f0eb` | `acl-0658583ca356c81f9` (default) | **`acl-09e600e410924d679`** | E3.1 |

The two public subnets, and only those two. The private ones did not move. **That is the
replacement the whole runbook ordering depends on**, visible in the ids: associating does not
layer, it changes owner.

### E3.2 — The log group is disposable

| Item | Value | Expected | Step |
|---|---|---|---|
| `logGroupName` | `Net-M2-FlowLogsLogGroup9853A85F-22SQhYmrFg7X` | the output's | E3.2 |
| `retentionInDays` | **`7`** | 7 | E3.2 |

**Not `730`.** The construct owns its log group, with `ONE_WEEK` and `DESTROY`. G2-05 holds against
AWS, not only against the template.

### E3.3 / E3.4 — The ACCEPTs

| Item | Value | Step |
|---|---|---|
| UTC mark of the generated traffic | `2026-10-14T15:33:14Z` | E3.3 |
| Probes sent | 10 × `curl $URL/` | E3.3 |
| Aggregated lines carrying `$ME` | 1 | E3.4 |

The line, read through the field map:

```
ACTION   SRCADDR          DSTADDR          SPORT  DPORT  DIRECTION
ACCEPT   157.100.134.236  10.0.1.110       31205  80     ingress
```

| Field | Value | Expected |
|---|---|---|
| `action` (13) | `ACCEPT` | `ACCEPT` ✅ |
| `srcaddr` (4) | `157.100.134.236` | `$ME` ✅ |
| `dstaddr` (5) | `10.0.1.110` | an ALB node in a public subnet ✅ |
| `srcport` (6) | `31205` | client ephemeral |
| `dstport` (7) | `80` | `80` ✅ |
| `flow-direction` (17) | `ingress` | `ingress` ✅ |

The 10 probes collapsed into **one** line: that is the 60s aggregation interval doing its job, not
lost evidence. And `dstaddr = 10.0.1.110` is the private IP of a balancer node inside a public
subnet — precisely the traffic this NACL governs.

---

## 4. E1 — Deny by source

| Item | Value | Step |
|---|---|---|
| `deniedSources` deployed | `['157.100.134.236/32']` | E1 |
| `npm test` with the new value | **1 failure, 81 pass** — see below | E1 |
| New resources in `cdk diff` | **1**: `[+] AWS::EC2::NetworkAclEntry NetworkAcls/Acl/Deny0` | E1 |
| Entries renumbered | **none** | E1 |
| `DeniedSources` output before measuring | `157.100.134.236/32` | E1 |
| Deploy time | 13.6s (4 events, in-place update) | E1 |

### The `npm test` failure is the guard working

```
● module 2 config › deniedSources defaults to empty — a plain deploy denies nobody
    - Array []
    + Array ["157.100.134.236/32"]
```

`test/config.test.ts:24` guards that **the committed default** denies nobody, and E1 violates it
on purpose — the comment on `MODULE_2_NACL.deniedSources` says so: *"E1 editing this array is a
deliberate, reviewed change, not shipped policy"*.

**Only that one dropped.** The remaining 81 pass, including every NACL test:
`module2-network-acls.test.ts` builds its own `deniedSources` from documentation CIDRs
(`203.0.113.0/24`) instead of reading the config, so the run's real value never touches them. That
independence is what makes the failure legible as "the default changed" rather than "the NACL
broke".

### E1.1 — The measurement

| Origin | `http_code | time_total` | Expected | Step |
|---|---|---|---|
| From my network (`157.100.134.236`, denied) | **`000 | 15.017551s`** | `000`, ~15s ✅ | E1.1 |
| From another network | see below — **answered by internet background traffic** | `ACCEPT` ✅ | E1.1 |

The `15.017551s` is `--max-time 15` cutting off, not a response: a packet denied at the NACL is
dropped **without an RST**, so the client never receives a rejection and waits until it gives up.

### E1.2 — The REJECT in the log

```
ACTION   SRCADDR          DSTADDR          SPORT  DPORT  DIRECTION
REJECT   157.100.134.236  10.0.1.110       31142  80     ingress
```

| Field | Value | Expected |
|---|---|---|
| `action` (13) | `REJECT` | `REJECT` ✅ |
| `srcaddr` (4) | `157.100.134.236` | `$ME` ✅ |
| `dstaddr` (5) | `10.0.1.110` | ALB node in a public subnet ✅ |
| `srcport` (6) | `31142` | client ephemeral |
| `dstport` (7) | `80` | `80` ✅ |
| `flow-direction` (17) | `ingress` | `ingress` ✅ |

It is the SYN, dropped at the subnet edge.

### The ACCEPT/REJECT pair is the strongest evidence in the run

Side by side, both lines from the same flow log:

```
ACCEPT   157.100.134.236  10.0.1.110  31205  80  ingress     ← E3, no deny
REJECT   157.100.134.236  10.0.1.110  31142  80  ingress     ← E1, deny at rule 10
```

**Same source, same destination, same port, same direction, same interface on the same balancer
node.** The only thing that changed between them is one NACL entry numbered 10. The source port
differs (31205 → 31142) because they are two distinct TCP connections, and that is all that
differs.

That turns E1 from "the request failed" into "the NACL rejected it": no other variable moved
between the two measurements. And it is what plan §5 warned the flow log **cannot** do on its own —
a line says REJECT, not "the NACL did this". Here the attribution does not come from the log, it
comes from having the earlier ACCEPT with every other field identical. Which is why E3 runs before
E1 and not at the end.

### E1.3 — The deny is specific, and the internet proved it

The deny was created at **10:49:39**. In the same flow log, same port 80, same NACL, after that
instant:

| Time | Action | Source |
|---|---|---|
| 10:49:56 | **ACCEPT** | `45.198.224.89` |
| 10:51:53 | **REJECT** | `157.100.134.236` ← the denied CIDR |
| 10:51:58 | **REJECT** | `157.100.134.236` |
| 10:52:21 | **REJECT** | `157.100.134.236` |
| 10:52:21 | **REJECT** | `157.100.134.236` |
| 10:52:59 | **ACCEPT** | `94.154.43.250` |
| 10:59:10 | **ACCEPT** | `5.224.85.150` |
| 11:00:54 | **ACCEPT** | `94.154.43.250` |

**That is E1.1 complete, and it is stronger evidence than a probe from a phone.** Four independent
public sources crossed the same NACL, through the same port, interleaved in time with the denied
CIDR's rejections. One external probe proves that *another* IP passes; four interleaved ones prove
the rule discriminates **by source and nothing else**, because no other variable could have changed
between 10:51:58 and 10:52:59.

A security group cannot produce this table. It has no way to express the middle row.

### Where that unasked-for traffic came from

Across the window's ~30 minutes, **16 distinct public addresses** touched port 80 uninvited, all
with `ACCEPT` — because `AllowPublicPortIn` permits tcp/80 from `0.0.0.0/0`, which is exactly what
a public web tier has to do.

It is internet background scanning, and it is not a finding of this module: it is the baseline of
any public IPv4. The flow log only makes it visible. It also explains why it works as a control:
it arrives on its own, continuously, and is indifferent to the experiment.

The rest of the noise in the same window, all rejected by the NACL: `23` (telnet) from
`167.99.250.53` and `162.219.178.250`, `137` (NetBIOS) from a dozen sources, `17002`/`17006` from
`62.210.142.169`. None of those ports has an ingress allow, so they land in the implicit `32767`
deny.

### Why the phone did not load — and it was not the NACL

The phone's browser **never asked for port 80**. It asked for 443:

| Source | Dest port | Action | Count |
|---|---|---|---|
| `186.65.19.60` → `10.0.0.242` | 443 | REJECT | 28 |
| `186.65.19.60` → `10.0.1.110` | 443 | REJECT | 26 |

`186.65.19.60` does **not appear once** on port 80, and it is not in `deniedSources`. All 54
attempts go to 443, against both balancer nodes.

Two chained reasons, neither related to E1:

1. **There is no 443 listener.** The external ALB has exactly one, `HTTP:80` (verified with
   `describe-listeners`): ADR-0018 makes the certificate optional and
   [ADR-0023](../docs/adr/0023-no-redirect-listener.md) decides against a redirect listener.
2. **The NACL does not allow 443 on ingress either.** Ingress opens 80, ICMP and 1024-65535; 443
   exists only on *egress* (`AllowHttpsOut`, rule 110). So the SYN to 443 dies in the implicit deny
   before ever discovering nobody is listening.

The root cause is the browser: mobile Chrome and Safari force HTTPS by default and rewrite
`http://` to `https://`. Against an endpoint that only speaks HTTP on 80, that fails every time —
deny or no deny.

**The phone result was a false negative**, and without the flow log it would have been filed as "E1
blocks the phone too", which is precisely the wrong conclusion. What dismantles it is not an
argument: it is that `186.65.19.60` does not appear on port 80 even once.

> To repeat it without fighting the browser: tether the laptop to the phone's hotspot and run the
> same `curl`. `curl` does not rewrite the scheme.

### E1.4 — Band ordering, against AWS

| # | Action | Observed | Step |
|---|---|---|---|
| 10 | **deny** | ✅ `Deny0` | E1.4 |
| 100 | allow | ✅ `AllowPublicPortIn` | E1.4 |
| 110 | allow | ✅ `AllowIcmpIn` | E1.4 |
| 120 | allow | ✅ `AllowEphemeralIn` | E1.4 |
| 32767 | deny | ✅ AWS implicit | E1.4 |

**The deny landed at 10, below every allow, and nothing was renumbered.** ADR-0033 holds against
AWS: `cdk diff` added exactly one resource and did not touch any existing rule's number — the
property E2's ability to remove a slot without collision depends on.

---

## 5. E2 — The stateless gotcha

> **Before starting: `deniedSources` goes back to `[]`.** With E1's deny live, the SYN never
> reaches the subnet and the `000` measured is E1's again. The external symptom is identical.

### E2.0 — The toggle has no default-value guard, and that is a finding

| Item | Value | Step |
|---|---|---|
| `npm test` with `openEphemeralEgress: false` | **82 pass, 0 failures** | E2 |

Compare against E1, where changing `deniedSources` turned the suite red as a warning.
`test/config.test.ts` guards `deniedSources`' default and **guards nothing about
`openEphemeralEgress`**. The `test.each([[true],[false]])` cases prove the construct behaves
correctly in both branches; what nothing proves is **which of the two is in the config**.

So a committed `openEphemeralEgress: false` passes the entire suite, passes CI, and breaks the
deploy for the next person who clones the repo — with no symptom at all. The closing checklist in
§7 is currently the only thing standing between that and `main`, and a checklist is not a guard.
Carried as a follow-up.

### E2.1 — The live branch, confirmed before measuring

| Output | Value | Expected | Step |
|---|---|---|---|
| `EphemeralEgressOpen` | **`false`** | `false` ✅ | E2.1 |
| `DeniedSources` | **`none`** | `none` ✅ | E2.1 |

### E2.2 — The numbering invariant survives the toggle

`cdk diff` removed exactly two resources and renumbered nothing:

```
[-] AWS::EC2::NetworkAclEntry NetworkAcls/Acl/AllowEphemeralOut   destroy
[-] AWS::EC2::NetworkAclEntry NetworkAcls/Acl/Deny0               destroy
```

The egress table against AWS afterwards:

| # | Entry | Observed | Step |
|---|---|---|---|
| 100 | *(empty — `AllowEphemeralOut` removed)* | ✅ absent | E2.1 |
| 110 | `AllowHttpsOut` tcp 443-443 | ✅ **still 110** | E2.1 |
| 120 | `AllowPublicPortOut` tcp 80-80 | ✅ still 120 | E2.1 |
| 130 | `AllowIcmpOut` icmp | ✅ still 130 | E2.1 |
| 32767 | AWS implicit deny | ✅ | E2.1 |

**443 stayed at 110 with 100 standing empty.** That is ADR-0033's whole argument, measured: a
counter advanced only for enabled slots would have moved `AllowHttpsOut` down to 100, and because
`RuleNumber` is replace-on-update it would have collided mid-update with whatever already held
that number — breaking the very deploy the toggle exists to demonstrate. Numbering by declaration
index and filtering afterwards kept every surviving rule fixed. Deploy: 13.62s, 2 deletes, zero
replacements.

### E2.3 — The measurement

```
*   Trying 52.5.168.95:80...
*   Trying 100.51.5.114:80...
* Connection timed out after 15002 milliseconds
curl: (28) Connection timed out after 15002 milliseconds
```

| Item | Value | Expected | Step |
|---|---|---|---|
| Last line `curl -v` printed | `Trying 100.51.5.114:80...` | `Trying <ip>:80...` ✅ | E2.2 |
| Did it print `Connected`? | **no** | no ✅ | E2.2 |
| Timeout | `15002 ms`, `curl: (28)` | ~15s ✅ | E2.2 |

**`Connected` never appears**, which is the observable difference between this and an application
failure: the dropped packet is the **SYN-ACK**, so the handshake never completes and there is no
connection to fail a request on.

`curl` tried **both** balancer node addresses (`52.5.168.95` and `100.51.5.114`, one per AZ) and
both timed out. The NACL is associated with both public subnets, so there was no healthy path to
find.

### E2.4 — The two REJECT patterns, separated

E2's lesson — the stateless reply, four lines after the 11:09:41 deploy:

```
11:09:51  REJECT  10.0.0.242 -> 157.100.134.236  sport=80  dport=31205  egress
11:09:57  REJECT  10.0.1.110 -> 157.100.134.236  sport=80  dport=2366   egress
11:10:21  REJECT  10.0.0.242 -> 157.100.134.236  sport=80  dport=31205  egress
11:10:22  REJECT  10.0.1.110 -> 157.100.134.236  sport=80  dport=2366   egress
```

| Field | Value | Expected |
|---|---|---|
| `flow-direction` (17) | `egress` | `egress` ✅ |
| `srcaddr` (4) | `10.0.0.242` / `10.0.1.110` | the two ALB nodes ✅ |
| `srcport` (6) | `80` | `80` ✅ |
| `dstaddr` (5) | `157.100.134.236` | `$ME` ✅ |
| `dstport` (7) | `31205` / `2366` | client ephemeral ✅ |

Two lines per node, ~30s apart: that is TCP SYN retransmission. The client resent the SYN, the ALB
answered again, and the reply was dropped again.

The collateral — the forwarding and health-check traffic toward the frontend tier:

```
11:09:26  10.0.1.110 -> 10.0.2.198  dport=8080  egress
11:09:51  10.0.0.242 -> 10.0.2.198  dport=8080  egress   (×3)
11:09:57  10.0.1.110 -> 10.0.2.198  dport=8080  egress   (×3)
11:10:21  10.0.0.242 -> 10.0.2.198  dport=8080  egress   (×3)
```

| Field | Value | Expected |
|---|---|---|
| `flow-direction` (17) | `egress` | `egress` ✅ |
| `dstport` (7) | `8080` | `8080` ✅ |
| `dstaddr` (5) | `10.0.2.198` | inside `10.0.0.0/16` ✅ |
| Cadence | continuous while the toggle was `false` | every 10s ✅ |

`10.0.2.198` is the frontend instance, in a **private** subnet still on the default NACL. The drop
does not happen at its end — it happens on the way **out** of the public subnet, which is where
this NACL sits. Expected collateral, and the direct consequence of the range ADR-0034 documents:
`PORTS.frontend = 8080` lives inside 1024-65535.

### The direction flipped, and that is the entire lesson

Both experiments in one table, same NACL, same client, same port 80:

| Time | Action | Flow | `srcport` | Direction | Experiment |
|---|---|---|---|---|---|
| 10:51:53 | REJECT | `157.100.134.236` → `10.0.1.110:80` | 31142 | **ingress** | E1 — the SYN, on the way in |
| 10:52:21 | REJECT | `157.100.134.236` → `10.0.0.242:80` | 31211 | **ingress** | E1 |
| 11:09:51 | REJECT | `10.0.0.242:80` → `157.100.134.236` | **80** | **egress** | E2 — the SYN-ACK, on the way out |
| 11:10:22 | REJECT | `10.0.1.110:80` → `157.100.134.236` | **80** | **egress** | E2 |

From the client, E1 and E2 are indistinguishable: both are a `000` after ~15 seconds with no RST.
In the flow log they are opposites. E1 denies the request; E2 lets the request in and strands the
answer — because a NACL evaluates every packet on its own and knows nothing about the connection
the previous packet established.

**This is the one pattern attributable from the log alone** (plan §5): a security group is stateful
and would have let the reply back out with no egress rule whatsoever. An egress REJECT carrying
`srcport=80` toward a client that just sent a SYN can only be a stateless filter.

### E2.5 — Collateral damage in target health

| Moment | State | `Reason` | Step |
|---|---|---|---|
| Before | **`healthy`** | — | E0.4 |
| With the toggle at `false` | **`unhealthy`** | **`Target.Timeout`** | E2.4 |
| After the fix | **`healthy`** | — | E2.5 |

Target `i-0516bc8ff8a6c3586`. From the internet this damage is invisible — a client sees the same
timeout either way. Only the flow log and `describe-target-health` show that the balancer also lost
its own path to the tier.

### E2.6 — The fix

| Item | Value | Step |
|---|---|---|
| `cdk diff` / deploy | 1 create: `AllowEphemeralOut` restored at rule 100 | E2.5 |
| Deploy time | 7.96s | E2.5 |
| `EphemeralEgressOpen` after deploy | `true` | E2.5 |
| Seconds waited until `healthy` | **~10s** | E2.5 |
| **`http_code | time_total` after the fix** | **`200 | 0.209514s`** | E2.5 |

Against E0.3's baseline `/` of `200 · 0.229119s`, the post-fix latency is statistically identical.
The entry came back in a single create and the targets recovered inside one health-check cycle —
nothing had to be rebuilt, because nothing was destroyed. A NACL entry is a rule, not state.

### The recovery stalled first, and the reason is worth keeping

The first attempt at this step ran the wait loop **before** the redeploy. The loop was an unbounded
`until`, so it spun for ~170 seconds printing "waiting for the health-check cycle" while the egress
rule was still missing and the targets could never recover.

Three things made it opaque, and all three are the same lesson:

- **The symptom was patience.** An unbounded loop with a reassuring message is indistinguishable
  from a slow recovery. The runbook now caps it at 60s and says `STILL UNHEALTHY` instead.
- **Nothing in the loop's output named the cause.** The client's `000` and the target's `unhealthy`
  share one cause and neither mentions it.
- **Two commands settled it:** `EphemeralEgressOpen` read `false`, and rule 100 was absent from
  AWS. Which is exactly what that output exists for — *"Which E2 branch is live — the fact that
  prevents measuring the wrong deploy"*. Without it the next move is reading the template or
  guessing.

A measurement step whose failure mode is "wait longer" needs a bound. Carried in §7.

---

## 6. Teardown

Destroyed in order, `Net-M2` first. Verified by resource rather than by stack, because the billing
is on the resources:

| Check | Result | Step |
|---|---|---|
| `describe-stacks Net-M2` | `Stack with id Net-M2 does not exist` ✅ | §6 |
| `describe-stacks Net-M1` | `Stack with id Net-M1 does not exist` ✅ | §6 |
| `describe-addresses` | `[]` ✅ | §6 |
| `describe-nat-gateways` (available) | `[]` ✅ | §6 |
| `describe-instances` (running/pending) | `[]` ✅ | §6 |
| `describe-load-balancers` | `[]` ✅ | §6 |
| `describe-vpcs` (non-default) | `[]` ✅ | §6 |
| Flow log group | `[]` ✅ | §6 |

| Item | Value |
|---|---|
| Infrastructure up from | 2026-10-14 10:21 to ~11:35 (local) |
| Total | ~1h 15m |
| Estimated cost at ~$0.128/h | **~$0.16** |

**G2-05 closed end to end.** `RemovalPolicy.DESTROY` asserted in the template, `retention: 7`
verified against AWS, and now the log group's disappearance verified after the `destroy`. Had the
construct not owned its log group, what would remain here is one CDK-created group at two-year
retention, billing storage quietly — the failure ADR-0035 exists to prevent, and the only place it
would ever have surfaced is a bill.

The empty `describe-addresses` is the other one that is not a formality: since 2024-02-01 every
public IPv4 address is billed whether associated or not, and an orphaned Elastic IP is the most
common teardown surprise.

### The open question from plan §11

| Question | Observed |
|---|---|
| Does `cdk destroy Net-M1` ahead of `Net-M2` fail with `DependencyViolation`, or succeed and orphan module 2? | not measured |

One new data point narrows it: in the **deploy** direction the CLI resolved the dependency on its
own (`Including dependency stacks: Net-M1`). That says nothing about `destroy`, which is the one
that consults nothing — but it is worth recording that the implicit dependency exists and the CLI
sees it.

---

## 7. What the run left open

| Finding | What to do about it |
|---|---|
| ~~`openEphemeralEgress` has no default-value guard~~ | **Closed.** `test/config.test.ts` now asserts the default is `true`, mirroring the `deniedSources` guard. Verified in both directions: passes with `true`, fails with `false`. Suite is 83 tests |
| G2-06 needed a second query to be measurable | `Protocol` is a string in the EC2 API; a backtick numeric literal silently returns `[]`. Fixed in the runbook, worth knowing before writing any new `--query` against it |
| Neither stack exports the VPC id as a named output | Reached via `describe-stack-resources`. The `PublishOutputRefVpc…` that `weak` generates contains it, but its name is a token, not a contract |
| `MODULE_2_NAME_PREFIX` is still unread | Visible in this run: everything was identified by id (`acl-…`, `fl-…`), never by name. Exactly the cost plan §11 anticipated |
| Mobile browsers force HTTPS, so a phone cannot probe an HTTP-only endpoint | Cost one false negative in E1.1 before the flow log explained it. Tethering plus `curl` is the reliable route; the runbook now says so in E1.3 |
| The E2.5 wait loop was an unbounded `until` | Spun ~170s against a state that could never recover, reading as patience. Now capped at 60s and followed by the two queries that name the cause — see §5 E2.6 |
| `--filter-pattern "REJECT" "$ME"` matches E1 and E2 alike | Inside a 30-minute window the stale E1 ingress line comes back first and reads like a finished E2 measurement. The runbook now prints the timestamp and `flow-direction`, which also makes the direction flip visible |

Closing checklist:

- [x] `lib/config.ts` back to its defaults: `deniedSources: []`, `openEphemeralEgress: true`
- [x] `cdk destroy` both stacks, in order — verified resource by resource above
- [x] `README.md`: assertion count, module 2 status, and the bare `cdk deploy`/`destroy` commands
      that stopped working once the app held two stacks
- [x] `docs/plans/module2-network-acls-flow-logs.md` §9 rewritten with what was measured, plus the
      three things the run found that the plan had not anticipated
- [x] The `openEphemeralEgress` guard, which is what makes the first line of this checklist
      enforced rather than remembered

That last item is the one worth noting. Everything above it was a checklist, and a checklist held
for the whole run — but it held because someone was reading it. The run's own evidence is that it
nearly did not: the config sat at `openEphemeralEgress: false` through a green 82-test suite, and
what caught it was a wait loop spinning for 170 seconds, not a guard.

Now there is a guard. A committed `openEphemeralEgress: false` turns the suite red, the same way
a committed `deniedSources` does — which is the only reason E1 was ever safe to stage.
