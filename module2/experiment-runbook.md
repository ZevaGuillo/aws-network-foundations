# Experiment runbook — Module 2: Network ACLs + VPC Flow Logs

**What this file is:** the procedure, the commands and the expected values for module 2's four
experiments. Measurements do not go here: they go to [`evidence.md`](evidence.md).

**What it is not:** an explanation of the design. That lives in
[`docs/plans/module2-network-acls-flow-logs.md`](../docs/plans/module2-network-acls-flow-logs.md)
and in the ADRs that plan links. This file only executes.

**Shell:** Git Bash. The `--query` and `--filter-pattern` arguments below use POSIX single quotes
and `$VAR`; PowerShell parses them differently and breaks them silently — returning empty rather
than failing, which is the worst way for a measurement to fail.

---

## 0. One session, and what it costs

All four experiments run **in a single window**, with one `deploy Net-M1` at the start and one
`destroy` at the end. E1 and E2 only redeploy `Net-M2`, which is a minute or two each — module 1
is never touched again. Cycling module 1's `deploy`/`destroy` between experiments saves nothing
and ruins E0, because every new VPC ships a new default NACL with a different id.

| Leg | Approx. time |
|---|---|
| `deploy Net-M1` + app boot + targets in service | 8-10 min |
| E0 — baseline | 1 min |
| `deploy Net-M2` + E3 (includes the flow-log wait) | 8 min |
| E1 — edit, `npm test`, redeploy, measure, read the log | 10 min |
| E2 — edit, redeploy, measure, read both patterns, revert, wait for `healthy` | 15 min |
| `destroy Net-M2` + `destroy Net-M1` | 5-8 min |
| **Total** | **~50-60 min** |

At $0.128/hour, **the complete run costs about $0.15.** Flow-log ingestion into CloudWatch Logs
over idle infrastructure is a few MB: fractions of a cent.

**What costs money is not the measurement hour. It is forgetting to destroy.** That is ~$93/month,
and it is the only figure in this file that can hurt. Which is why §6's teardown is part of the
runbook rather than a footnote — and why its two verifications (`describe-addresses` empty, log
group gone) are not a formality.

---

## 0.1 Execution order, and why it is not negotiable

| Order | Experiment | Infrastructure state |
|---|---|---|
| 1 | **E0** — baseline | **Before** `cdk deploy Net-M2` |
| 2 | **E3** — flow logs recording | `Net-M2` deployed with defaults |
| 3 | **E1** — deny by source | `deniedSources: ['<MY_IP>/32']` |
| 4 | **E2** — the stateless gotcha | `deniedSources: []` **and** `openEphemeralEgress: false` |

Two of those rows carry a reason that costs either money or the whole measurement:

**E0 runs before the deploy.** Associating a subnet with a NACL *replaces*, it does not layer:
the default NACL's allow-all stops applying to module 1's public subnets the moment the
association exists. Run afterwards, E0 records as "before" a NACL that no longer governs any of
what is being measured. Editing does not recover it — it takes `cdk destroy Net-M2` and starting
over.

**E3 runs before E1.** A deny measured against a log that started afterwards produces a timeout
and no evidence.

---

## 1. Preparation — from scratch

### 1.1 — The preconditions this repo enforces rather than assumes

```bash
cd /d/Documentos/AWS/aws-projects/aws-network-foundations

node --version                 # 22 or later; npm install refuses below that (ADR-0013)
aws sts get-caller-identity    # must return an identity
aws configure get region       # must return a region
```

The two `aws` calls are not a courtesy. This app **refuses to synthesize without credentials**,
by design: an environment-agnostic stack resolves availability zones to an `Fn::GetAZs`
placeholder, which would make `maxAzs: 2` a count rather than two known zones
([ADR-0010](../docs/adr/0010-resolve-the-deployment-environment-from-the-cli.md)).

### 1.2 — Build and verify locally, without touching the account

```bash
npm install
npm test                       # 10 suites, 83 tests. No AWS calls
npx tsc --noEmit
npx cdk synth --strict         # clean for both Net-M1 and Net-M2
```

`npm test` and `cdk synth` are free and create nothing. If either fails, stop here: measuring
infrastructure whose template is unverified is measuring noise.

### 1.3 — Bootstrap, once per account and region

```bash
npx cdk bootstrap
```

Creates the S3 bucket and IAM roles the CDK needs to stage assets. It is idempotent: running it
again on an already-bootstrapped account does no harm.

### 1.4 — Deploy module 1, and only module 1

```bash
npx cdk ls                                        # expected: Net-M1 and Net-M2
npx cdk deploy Net-M1 --require-approval never
```

> **The stack name is not optional here.** The README still documents a bare `npx cdk deploy`,
> from when the app held a single stack. With two, the CLI demands a selector or `--all` — and
> **`--all` would deploy `Net-M2` alongside `Net-M1`**, destroying E0's baseline before there is
> any chance to take it (§0.1). Name the stack. Always.

Module 1 takes a few minutes, and the application takes another ~92s per instance after
CloudFormation reports the stack complete: Amazon Linux 2023 does not ship Node and every launch
installs the runtime ([ADR-0031](../docs/adr/0031-one-runtime-node.md)). Do not measure E0 until
E0.4 returns `healthy`.

> **Billing starts here.** Module 1 is ~$0.13/hour (~$93/month) completely idle: NAT gateway, two
> ALBs, three public IPv4 addresses and two `t3.micro`. Module 2 adds the flow log, which is
> cents. Count the hours between experiments.

### 1.5 — If something was already deployed

```bash
aws cloudformation describe-stacks --stack-name Net-M1 \
  --query 'Stacks[0].StackStatus' --output text     # expected: CREATE_COMPLETE or UPDATE_COMPLETE

aws cloudformation describe-stacks --stack-name Net-M2 \
  --query 'Stacks[0].StackStatus' --output text 2>&1 | head -1
```

The second one **must fail** with `Stack with id Net-M2 does not exist`. If it returns a status,
`Net-M2` is already deployed and E0's baseline is already lost: run
`npx cdk destroy Net-M2 --force` and only then continue with §2.

### Variables the whole runbook reuses

These are lost when the terminal closes. Coming back to the runbook in another session means
re-running this block before anything else.

```bash
# Your public IP as AWS sees it. This is $ME in E1 and E2.
ME=$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')

# The VPC id. Neither stack declares it as an output (plan §11), so it is reached
# through the stack's resources.
VPC=$(aws cloudformation describe-stack-resources --stack-name Net-M1 \
        --query "StackResources[?ResourceType=='AWS::EC2::VPC'].PhysicalResourceId" \
        --output text)

# The public entry point, with its scheme already resolved by the stack.
URL=$(aws cloudformation describe-stacks --stack-name Net-M1 \
        --query "Stacks[0].Outputs[?OutputKey=='ExternalUrl'].OutputValue" --output text)

# The frontend target group: E2 needs it to see the collateral damage.
FTG=$(aws cloudformation describe-stacks --stack-name Net-M1 \
        --query "Stacks[0].Outputs[?OutputKey=='FrontendTargetGroupArn'].OutputValue" \
        --output text)

echo "ME=$ME"; echo "VPC=$VPC"; echo "URL=$URL"
```

If any of them comes back empty, stop here. An empty `$URL` turns every `curl` below into a `000`
that measures nothing and looks exactly like a deny.

---

## 2. E0 — Baseline

> **This runs BEFORE `cdk deploy Net-M2`.** See §0.1.

### E0.1 — The default NACL, which no stack can declare

The CDK has no addressable handle on a VPC's default NACL, so `declareOutputs()` cannot name it
(G2-01). It is one documented CLI step rather than a hunt:

```bash
aws ec2 describe-network-acls \
  --filters Name=vpc-id,Values=$VPC Name=default,Values=true \
  --query 'NetworkAcls[0].{Id:NetworkAclId,Entries:Entries}' \
  | tee "module2/e0-default-nacl.json"
```

**Expected:** a NACL with exactly four entries — `100 allow all` and `32767 deny all` in each
direction. Those two `100` rules are the SAA-C03 lab's shortcut and the reason this module builds
its NACL from scratch: with an allow-all already sitting at 100, rule ordering never fails and
statelessness is never noticed.

Record the `Id` and the four entries in the evidence file.

### E0.2 — The subnets about to change NACL

The current associations are what the deploy will replace:

```bash
aws ec2 describe-network-acls \
  --filters Name=vpc-id,Values=$VPC Name=default,Values=true \
  --query 'NetworkAcls[0].Associations[].{Subnet:SubnetId,Assoc:NetworkAclAssociationId}' \
  --output table
```

And the ids the stack will claim, so they can be cross-checked later:

```bash
aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC \
  --query 'Subnets[].{Id:SubnetId,Az:AvailabilityZone,Cidr:CidrBlock}' --output table
```

### E0.3 — The three routes, healthy

```bash
for route in / /health /health/deep; do
  printf '%-14s ' "$route"
  curl -s -o /dev/null -w '%{http_code} | %{time_total}s\n' --max-time 15 "$URL$route"
done
```

**Expected:** `200` on all three. `/health` is the balancer's shallow check
([ADR-0019](../docs/adr/0019-shallow-health-check-at-the-balancer.md)) and `/health/deep` is the
reachability probe toward the internal tier
([ADR-0029](../docs/adr/0029-the-deep-check-is-a-reachability-probe.md)). All three returning
`200` is what makes any later `000` attributable to the NACL rather than to the application.

### E0.4 — Target health, healthy

```bash
aws elbv2 describe-target-health --target-group-arn $FTG \
  --query 'TargetHealthDescriptions[].TargetHealth.State' --output text
```

**Expected:** `healthy`. This row exists for E2: without a `healthy` on record first, E2's
`unhealthy` proves nothing.

### E0.5 — ICMP: the row with no measurable target

The plan notes that an ALB does not answer ICMP, so the `ping` row is only meaningful against an
instance. But module 1's two instances live in private subnets and
[ADR-0012](../docs/adr/0012-never-auto-assign-public-ipv4-addresses.md) denies them a public
IPv4, so **from the internet there is nothing in module 1 that can be pinged**.

```bash
ping -n 2 "$(echo "$URL" | sed -E 's#^https?://##')"   # Git Bash on Windows uses -n, not -c
```

**Expected:** timeout, 100% of the time. Record it as *no measurable target* — not as a deny. The
`AllowIcmpIn` / `AllowIcmpOut` rules are verified by the template (G2-06) and not by this probe;
claiming otherwise would read an ALB timeout as NACL evidence.

---

## 3. E3 — Flow logs recording

```bash
npx cdk diff Net-M2      # first deploy: everything is a creation
npx cdk deploy Net-M2 --require-approval never
```

Capture the new stack's outputs:

```bash
NACL=$(aws cloudformation describe-stacks --stack-name Net-M2 \
        --query "Stacks[0].Outputs[?OutputKey=='NetworkAclId'].OutputValue" --output text)

LG=$(aws cloudformation describe-stacks --stack-name Net-M2 \
      --query "Stacks[0].Outputs[?OutputKey=='FlowLogGroupName'].OutputValue" --output text)

# The three that make a desynchronised deploy readable in one line
aws cloudformation describe-stacks --stack-name Net-M2 \
  --query "Stacks[0].Outputs[?OutputKey=='PublicIngressPort' || OutputKey=='EphemeralEgressOpen' || OutputKey=='DeniedSources'].[OutputKey,OutputValue]" \
  --output table
```

**Expected:** `PublicIngressPort: 80` (no certificate,
[ADR-0018](../docs/adr/0018-the-certificate-is-optional.md)), `EphemeralEgressOpen: true`,
`DeniedSources: none`.

### E3.1 — The new NACL, as it landed in AWS

```bash
aws ec2 describe-network-acls --network-acl-ids $NACL \
  --query 'NetworkAcls[0].Entries[].{N:RuleNumber,Egress:Egress,Action:RuleAction,Proto:Protocol,From:PortRange.From,To:PortRange.To}' \
  --output table
```

**Expected**, in disjoint bands ([ADR-0033](../docs/adr/0033-rule-number-bands.md)) — denies in
10-99, allows from 100 in steps of 10:

| Direction | # | Entry | Traffic |
|---|---|---|---|
| ingress | 100 | `AllowPublicPortIn` | tcp/80 |
| ingress | 110 | `AllowIcmpIn` | ICMP `-1/-1` |
| ingress | 120 | `AllowEphemeralIn` | tcp 1024-65535 |
| ingress | 32767 | AWS implicit | deny all |
| egress | 100 | `AllowEphemeralOut` | tcp 1024-65535 |
| egress | 110 | `AllowHttpsOut` | tcp/443 |
| egress | 120 | `AllowPublicPortOut` | tcp/80 |
| egress | 130 | `AllowIcmpOut` | ICMP `-1/-1` |
| egress | 32767 | AWS implicit | deny all |

That `--query` selects `PortRange`, and **ICMP entries do not use it**: they carry their type in
`IcmpTypeCode`, so rows 110 ingress and 130 egress come back with `From: None / To: None`.
Measuring G2-06 against AWS takes a second query:

```bash
aws ec2 describe-network-acls --network-acl-ids $NACL \
  --query "NetworkAcls[0].Entries[?Protocol=='1'].{N:RuleNumber,Egress:Egress,Icmp:IcmpTypeCode}" \
  --output json
```

**Expected:** both entries (110 ingress, 130 egress) with exactly `{"Code": -1, "Type": -1}`. An
ICMP rule narrowed to one type in one direction is invisible in the table above.

> **The quotes around `'1'` are not style.** `Protocol` is a **string** in the EC2 API (`"6"`,
> `"1"`, `"-1"`), not a number. A `` Protocol==`1` `` compares against JMESPath's numeric literal
> 1, matches nothing, and **returns `[]` with no error and no warning** — an empty list that reads
> exactly like "there are no ICMP entries" when there are two. Hence the single quotes on the
> filter and double quotes on the whole `--query`.

And the associations, which are the measurable half of G2-07:

```bash
aws ec2 describe-network-acls --network-acl-ids $NACL \
  --query 'NetworkAcls[0].Associations[].SubnetId' --output text
```

**Expected:** the two public subnet ids E0.2 recorded against the default NACL. Their change of
owner is §0.1's replacement happening.

### E3.2 — The log group is disposable, and that gets verified

```bash
aws logs describe-log-groups --log-group-name-prefix "$LG" \
  --query 'logGroups[0].{Name:logGroupName,Retention:retentionInDays}' --output table
```

**Expected:** `Retention: 7`. If it says `730`, the CDK created the group on its own rather than
the construct — which is exactly the G2-05
[ADR-0035](../docs/adr/0035-the-flow-log-is-disposable-evidence.md) exists to prevent, and a
storage bill that survives the `destroy`.

### E3.3 — Generate traffic and wait

```bash
for i in $(seq 1 10); do curl -s -o /dev/null "$URL/"; done
date -u '+%Y-%m-%dT%H:%M:%SZ'    # record this mark: it anchors the window
```

**Wait 3 to 5 minutes.** The aggregation interval is 60 seconds
(`MODULE_2_FLOW_LOGS.aggregationIntervalSeconds`), but publication into CloudWatch Logs adds
latency of its own. An empty `filter-log-events` at minute one is not a broken flow log.

### E3.4 — Read the ACCEPTs

```bash
START=$(( ($(date +%s) - 1800) * 1000 ))     # last 30 minutes, in ms

aws logs filter-log-events --log-group-name "$LG" --start-time $START \
  --filter-pattern "\"$ME\"" \
  --query 'events[].message' --output text | head -20
```

**Expected:** lines with `ACCEPT` whose `srcaddr` is your `$ME` and whose `dstport` is `80`.

### The field map — without it the lines cannot be read

The format is not the CDK's default: it is the default's fields **plus** `pkt-dstaddr` and
`flow-direction`, which are what turn a REJECT into a direction-attributable fact
([ADR-0035](../docs/adr/0035-the-flow-log-is-disposable-evidence.md)). Every line carries 17
space-separated values, **in this order**:

| # | Field | # | Field |
|---|---|---|---|
| 1 | `version` | 10 | `bytes` |
| 2 | `account-id` | 11 | `start` |
| 3 | `interface-id` | 12 | `end` |
| 4 | `srcaddr` | 13 | **`action`** ← ACCEPT / REJECT |
| 5 | `dstaddr` | 14 | `log-status` |
| 6 | `srcport` | 15 | `pkt-srcaddr` |
| 7 | `dstport` | 16 | `pkt-dstaddr` |
| 8 | `protocol` | 17 | **`flow-direction`** ← ingress / egress |
| 9 | `packets` | | |

To read them as named columns:

```bash
aws logs filter-log-events --log-group-name "$LG" --start-time $START \
  --filter-pattern "\"$ME\"" --query 'events[].message' --output text \
| awk 'BEGIN { printf "%-8s %-16s %-16s %-6s %-6s %-10s\n","ACTION","SRCADDR","DSTADDR","SPORT","DPORT","DIRECTION" }
       { printf "%-8s %-16s %-16s %-6s %-6s %-10s\n", $13, $4, $5, $6, $7, $17 }'
```

### What the flow log does not say

A line says ACCEPT or REJECT, not "the NACL did this". A NACL deny and a security group with no
matching allow are **indistinguishable in the data** and are attributed by elimination. The one
pattern attributable from the log alone is E2's, because a security group never blocks a reply.

---

## 4. E1 — Deny by source

What the lab proves and a security group cannot: denying by source IP.

```bash
echo "$ME/32"      # copy this output
```

**Edit `lib/config.ts`**, inside `MODULE_2_NACL`:

```ts
deniedSources: ['<paste the value above>'] as readonly string[],
```

> **Append-only.** `denyIngress()` numbers by position within the already-sorted list, and a
> `RuleNumber` is replace-on-update in CloudFormation. Inserting a CIDR at the front renumbers
> every entry after it — the hazard plan §3 describes, applied to rules nobody touched. With a
> single element it does not apply; when a second one is added, it goes at the end.

```bash
npm test
```

> **`npm test` fails here, and the failure is correct.** Exactly one assertion drops:
>
> ```
> ● module 2 config › deniedSources defaults to empty — a plain deploy denies nobody
>     - Array []
>     + Array ["<your IP>/32"]
> ```
>
> `test/config.test.ts:24` guards that **the committed default** denies nobody, and E1 violates
> it on purpose: the comment on `MODULE_2_NACL.deniedSources` says exactly that — "E1 editing
> this array is a deliberate, reviewed change, not shipped policy". The guard is working.
>
> The other 81 pass, including every NACL test: `module2-network-acls.test.ts` builds its own
> `deniedSources` from documentation CIDRs (`203.0.113.0/24`) instead of reading the config, so
> the real value does not affect them. Confirming that **only** that one drops is the check.
>
> And it has to go back to green before committing anything. It is on the evidence file's closing
> checklist.

```bash
npx cdk diff Net-M2      # expected: 1 new NetworkAclEntry, RuleNumber 10, DENY
npx cdk deploy Net-M2 --require-approval never
```

Confirm which branch is live before measuring:

```bash
aws cloudformation describe-stacks --stack-name Net-M2 \
  --query "Stacks[0].Outputs[?OutputKey=='DeniedSources'].OutputValue" --output text
```

**Expected:** your `$ME/32`, not `none`. Measuring against the wrong output is measuring the
previous deploy.

### E1.1 — The measurement

```bash
curl -s -o /dev/null -w '%{http_code} | %{time_total}s\n' --max-time 15 "$URL/"
```

**Expected:** `000` at ~15s — the `--max-time` cutting off, not a response. A packet denied at
the NACL is dropped without an RST, so the client receives no rejection: it waits until it gives
up.

### E1.2 — The REJECT in the log

Wait 3-5 minutes, then:

```bash
START=$(( ($(date +%s) - 1800) * 1000 ))

aws logs filter-log-events --log-group-name "$LG" --start-time $START \
  --filter-pattern "\"REJECT\" \"$ME\"" \
  --query 'events[].message' --output text | head -10
```

**Expected:** `action = REJECT`, `srcaddr = $ME`, `dstport = 80`, `flow-direction = ingress`. It
is the SYN, dropped at the subnet edge.

### E1.3 — The proof that the deny is specific, not general

The `000` above does not distinguish a NACL deny from an application that is simply down. What
distinguishes them is a **different source reaching the same port in the same window**.

Reaching for a phone on mobile data is the obvious move and it has a trap: mobile browsers
(Chrome, Safari) force HTTPS by default and rewrite `http://` to `https://`. The external ALB has
only an `HTTP:80` listener ([ADR-0023](../docs/adr/0023-no-redirect-listener.md)) and the NACL's
ingress does not allow 443 at all, so the probe fails for a reason that has nothing to do with
the deny — and it fails looking exactly like the deny working.

Two reliable routes instead:

```bash
# Route A — tether the laptop to the phone's hotspot and run the same curl.
# curl does not rewrite the scheme.
curl -s -o /dev/null -w '%{http_code} | %{time_total}s\n' --max-time 15 "$URL/"
```

```bash
# Route B — read it off the background traffic the internet sends unasked.
# Every public source that touched port 80, with the time and the verdict:
START=$(( ($(date +%s) - 2400) * 1000 ))
aws logs filter-log-events --log-group-name "$LG" --start-time $START \
  --query 'events[].[timestamp,message]' --output text \
| awk -F'\t' '{ ts=$1; n=split($2,f," ");
                if (n>=17 && f[17]=="ingress" && f[7]=="80" && f[4] !~ /^10\./)
                  print strftime("%H:%M:%S", ts/1000), f[13], f[4] }' | sort
```

**Expected:** `REJECT` lines for `$ME` interleaved in time with `ACCEPT` lines from unrelated
public addresses. Route B is the stronger evidence of the two: one external probe shows that
*another* IP passes, while several interleaved sources show the rule discriminates **by source
and nothing else**, because no other variable could have changed between two entries seconds
apart.

That background traffic is internet-wide scanning, not a finding of this module — it is the
baseline of any public IPv4. It works as a control precisely because it arrives on its own,
continuously, and is indifferent to the experiment.

### E1.4 — Verify band ordering live

```bash
aws ec2 describe-network-acls --network-acl-ids $NACL \
  --query 'NetworkAcls[0].Entries[?Egress==`false`].[RuleNumber,RuleAction]' --output table
```

**Expected:** `10 deny` before `100 allow`. A deny above an allow is dead letter — clean
`cdk synth`, successful deploy, and no symptom beyond a request that should have been rejected
succeeding. G2-03 covers it in the suite; this line confirms it against AWS.

---

## 5. E2 — The stateless gotcha

> **Mandatory first step: revert `deniedSources` to `[]`.**
>
> Plan §6 asks for E1 then E2 and does not state this explicitly. If E1's deny is still live, the
> SYN never reaches the subnet and the `000` measured is E1's again — not statelessness. The
> external symptom of E1 and E2 is **identical**, so there is no way to detect the confusion from
> outside. It is detected by reading the outputs before measuring, which is what E2.1 does.

**Edit `lib/config.ts`**, inside `MODULE_2_NACL` — both at once:

```ts
deniedSources: [] as readonly string[],
openEphemeralEgress: false,
```

```bash
npm test
npx cdk diff Net-M2
```

> **`npm test` fails here too, with exactly one assertion — same as E1, and for the same reason:**
>
> ```
> ● module 2 config › openEphemeralEgress defaults to open — a plain deploy is not E2 mid-experiment
> ```
>
> That guard did not exist during the 2026-10-14 run, and its absence was the finding: the E2
> branch passed all 82 tests back then. The `test.each([[true],[false]])` cases prove the construct
> behaves correctly in both branches, but they pass explicit values and never read the config — so
> nothing looked at **which** branch was committed, and a committed `false` would have reached
> `main` green while breaking the deploy for the next clone. `test/config.test.ts` now carries the
> symmetric assertion; [`evidence.md`](evidence.md) §5 E2.0 records how it surfaced.
>
> So both experiments turn the suite red while they are staged, which is the point: the red is the
> reminder that the config is holding an experiment rather than a default. Confirm that **only**
> that one assertion drops.

**Expected in the diff:** `AllowEphemeralOut` removed, and **no other entry renumbered**. That is
the entire point of numbering by declaration index and filtering *after* numbering: a counter
advanced only for enabled slots would move `AllowHttpsOut` from 110 to 100 and collide with
whatever already holds that number — breaking the very deploy the toggle exists to demonstrate.

```bash
npx cdk deploy Net-M2 --require-approval never
```

### E2.1 — Confirm the branch before measuring

```bash
aws cloudformation describe-stacks --stack-name Net-M2 \
  --query "Stacks[0].Outputs[?OutputKey=='EphemeralEgressOpen' || OutputKey=='DeniedSources'].[OutputKey,OutputValue]" \
  --output table
```

**Expected:** `EphemeralEgressOpen: false` and `DeniedSources: none`. Both. If `DeniedSources`
does not say `none`, you are about to measure E1 again.

And the numbering invariant, against AWS:

```bash
aws ec2 describe-network-acls --network-acl-ids $NACL \
  --query 'NetworkAcls[0].Entries[?Egress==`true`].[RuleNumber,RuleAction,PortRange.From,PortRange.To]' \
  --output table
```

**Expected:** `AllowHttpsOut` still at **110** (tcp/443), with 100 now empty. If 443 shows up at
100, the numbering scheme broke.

### E2.2 — The measurement

```bash
curl -v --max-time 15 "$URL/"
```

**Expected:** it stays at `Trying <ip>:80...` and **never prints `Connected`**. The dropped packet
is the **SYN-ACK**, not an HTTP response: the handshake never completes. From outside this looks
exactly like E1 — and that is half the lesson. A security group is stateful and would have let the
reply back with no rule at all. A NACL does not.

```bash
curl -s -o /dev/null -w '%{http_code} | %{time_total}s\n' --max-time 15 "$URL/"
```

### E2.3 — Two REJECT patterns, and only one is the lesson

`PORTS.frontend = 8080` sits inside 1024-65535, so the toggle does not only cut the reply to your
own probe: it also cuts the external ALB's forwarding and health-check traffic toward the frontend
tier. Both patterns are in the log and **they are separable**.

E2's lesson — the stateless reply:

> **`--filter-pattern "\"REJECT\" \"$ME\""` alone is a trap here.** E1's REJECTs are still inside
> a 30-minute window, they also carry `$ME`, and they also say `REJECT`. The first line that comes
> back is E1's ingress SYN drop — which reads exactly like a successful E2 measurement until you
> check `flow-direction`. Re-running the same query just returns the same stale line.
>
> Print the timestamp and the direction, and the two stop being confusable:

```bash
aws logs filter-log-events --log-group-name "$LG" \
  --start-time $(( ($(date +%s) - 1200) * 1000 )) \
  --filter-pattern "\"REJECT\" \"$ME\"" \
  --query 'events[].[timestamp,message]' --output text \
| awk -F'\t' '{ ts=$1; n=split($2,f," ");
                if (n>=17) printf "%s  %-8s %-16s -> %-16s sport=%-6s dport=%-6s %s\n",
                  strftime("%H:%M:%S",ts/1000), f[13], f[4], f[5], f[6], f[7], f[17] }' | sort
```

**Expected:** `flow-direction = egress`, `srcport = 80`, `dstaddr = $ME`, `dstport` = your
client's measured ephemeral port. Two lines per balancer node, ~30s apart — that second one is TCP
retransmitting the SYN, not a second probe.

Keeping both experiments in one listing is worth more than filtering E1 out: the ingress rows and
the egress rows side by side are what show the direction flipping, which is the lesson itself.

The collateral — the health checks:

```bash
aws logs filter-log-events --log-group-name "$LG" --start-time $START \
  --filter-pattern "\"REJECT\" \"8080\"" --query 'events[].message' --output text | head -5
```

**Expected:** `flow-direction = egress`, `dstport = 8080`, `dstaddr` inside `10.0.0.0/16`, every
10 seconds for as long as the toggle is `false` (`HEALTH_CHECK.interval`).

This collateral is **expected**: it is the direct consequence of the range
[ADR-0034](../docs/adr/0034-ephemeral-range-rationale.md) documents, not a second failure mode the
toggle introduces. A permanent, narrower `AllowTargetsOut tcp/8080` below the ephemeral slot would
have isolated E2 — and was rejected, because it would survive the toggle and conceal that a
public-subnet ephemeral egress rule legitimately carries in-VPC traffic, which is part of what E2
teaches.

### E2.4 — The collateral damage, in target health

```bash
aws elbv2 describe-target-health --target-group-arn $FTG \
  --query 'TargetHealthDescriptions[].TargetHealth' --output table
```

**Expected:** `unhealthy`, with `Reason: Target.Timeout`. Compare against E0.4's `healthy`. From
the internet this damage is invisible; only the flow log and this call show it.

### E2.5 — Revert, and do NOT measure yet

**Edit `lib/config.ts`:** `openEphemeralEgress: true`.

```bash
npx cdk deploy Net-M2 --require-approval never
```

The entry is restored in a single create, but the targets are **already unhealthy** and the
balancer will not route to them until two consecutive checks pass. Measuring here records a `000`
the NACL had nothing to do with, filed under the row that is supposed to prove the fix worked.

Wait for them to come back rather than guessing the moment:

```bash
# -w, not bare -q: "unhealthy" contains "healthy" as a substring, and a `grep -q healthy`
# exits the loop on the first pass exactly when the target is still broken — the precise
# mistake this step exists to prevent.
#
# The attempt cap is the other half. Recovery is bounded: 2 consecutive passes at a 10s
# interval, so ~20-30s. Anything past that is not a slow health check, it is a different
# problem — most likely that the redeploy above never ran and the egress rule is still
# missing, in which case the targets can never recover and an unbounded `until` spins
# forever while looking like patience.
for i in $(seq 1 12); do
  if aws elbv2 describe-target-health --target-group-arn $FTG \
       --query 'TargetHealthDescriptions[].TargetHealth.State' --output text \
     | grep -qw healthy; then
    echo "targets healthy after ~$(( i * 5 ))s"; break
  fi
  [ "$i" = 12 ] && echo "STILL UNHEALTHY after 60s — check EphemeralEgressOpen below, do not keep waiting"
  sleep 5
done

# The two values that explain a stalled recovery, worth printing either way:
aws cloudformation describe-stacks --stack-name Net-M2 \
  --query "Stacks[0].Outputs[?OutputKey=='EphemeralEgressOpen'].OutputValue" --output text
aws ec2 describe-network-acls --network-acl-ids $NACL \
  --query 'NetworkAcls[0].Entries[?Egress==`true`]|[?RuleNumber==`100`]' --output json
```

`EphemeralEgressOpen` must read `true` and rule 100 must exist. An empty `[]` from that second
query is the stalled-recovery signature: the toggle was reverted in `lib/config.ts` but never
deployed.

Only now, the `http_code | time_total after the fix` row:

```bash
curl -s -o /dev/null -w '%{http_code} | %{time_total}s\n' --max-time 15 "$URL/"
```

**Expected:** `200`.

---

## 6. Teardown, in order

**`cdk destroy Net-M2` first, then `cdk destroy Net-M1`.**

Nothing in the CDK or CloudFormation enforces that. `Net-M2.addDependency(Net-M1)` is already
implicit from the references and it orders a combined operation, but `cdk destroy Net-M1` named
alone does not consult `Net-M2` at all. The only real CloudFormation-level guard was the
`Export`/`Fn::ImportValue` lock that `@aws-cdk/core:defaultCrossStackReferences: weak`
deliberately traded away repo-wide, and that module 3 still depends on.

**This checklist is the guard.** With the stack names misspelled, it guards nothing.

```bash
npx cdk destroy Net-M2 --force
npx cdk destroy Net-M1 --force
```

`Net-M2` holds no stateful resource and nothing outside it reads its outputs, so destroying it is
clean: the public subnets return to the default NACL and the log group goes with the stack.

The two verifications that are not a formality:

```bash
# Orphaned IPv4 addresses: since 2024-02-01 every one is billed, associated or not
aws ec2 describe-addresses

# The log group went with the stack (G2-05)
aws logs describe-log-groups --log-group-name-prefix "$LG" --query 'logGroups[].logGroupName'
```

**Expected:** both empty.

### Optional — the open question from plan §11

The plan leaves open whether `cdk destroy Net-M1` **before** `Net-M2` fails with a VPC
`DependencyViolation`, or succeeds and orphans module 2. It is empirical, and `weak` removed the
lock that would have policed it.

To measure it, do so **deliberately and once**, and record what was observed in the evidence file.
The failure is arguably the better outcome: the alternative is a silently orphaned NACL and flow
log that keep billing.

---

## 7. What gets recorded, and where

| Where | What |
|---|---|
| [`evidence.md`](evidence.md) | Every number the commands above printed |
| `module2/e0-default-nacl.json` | The default NACL, before the association displaces it |
| `lib/config.ts` | Must return to its defaults — `deniedSources: []`, `openEphemeralEgress: true` — before closing the module |

That last row is the one that gets forgotten. A committed `openEphemeralEgress: false` is a broken
deploy waiting for the next person who clones the repo — and §5 explains why no test will catch it.
