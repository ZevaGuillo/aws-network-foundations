# Lab notes — *Managing Peer Connections between Amazon Virtual Private Clouds*

**What this file is.** A reading of the AWS lab that module 3 is derived from, plus the resource
ids observed while it ran, on 2026-10-28.

**What this file is not.** Evidence. Every id below belongs to an AWS-managed sandbox account that
no longer exists, and every number describes the lab's topology, not this repository's.
`module3/evidence.md` — which does not exist yet — will hold measurements of `Net-M3`, taken by the
runbook, in this account. The two must not be confused: a sandbox id in an evidence table reads
as a measurement six months later.

**Why it lives in the repository at all.** Module 2's equivalent notes were kept in an external
file. They are gone — the file could not be found anywhere on disk when module 3 started, and the
two follow-ups it carried went with it. What survived from module 2 is what was committed. So this
is committed.

---

## 1. What the lab builds

| | Backend | Frontend |
|---|---|---|
| Region | `us-east-1` (N. Virginia) | `us-east-2` (Ohio) |
| VPC CIDR | `10.0.0.0/16` | `9.255.0.0/16` |
| Subnet | private, with a NAT Gateway | public |
| Instance | `t3.micro`, AL2023, no key pair | `t3.micro`, AL2023, no key pair |
| Access | EC2 Instance Connect Endpoint | public IPv4 |
| App | Node, port 3000 | Node, port 3000 — proxies to the backend's **private** address |

Peering is requested from Virginia and accepted in Ohio. One route is added to each side's route
table, both in the same step. The frontend page, previously empty, then renders the backend's
message.

## 2. Resource ids observed

Recorded because they are the only copy; useful only for reading the screenshots back.

| Resource | Id |
|---|---|
| VPC, backend (Virginia) | `vpc-0665fecaee27ade8a` |
| VPC, frontend (Ohio) | `vpc-097483e5f3683aa90` |
| Private subnet, backend | `subnet-0f13158d8e871b085` |
| Instance, backend | `i-0dc0008530c21181c` — private address `10.0.130.137` |
| Instance, frontend | `i-025c46c7153dd2b95` |
| Security group, backend | `sg-044ceabc6804b65e1` |
| Instance Connect Endpoint | `eice-0bec41f11c1ca5f2b` — maximum tunnel 3600 s |
| Route table, Virginia | `rtb-01162d2c41306ba80` |
| Route table, Ohio | `rtb-090755986233bc409` |
| Instance Connect source range shown by the Virginia console | `18.206.107.24/29` |

**Not captured, and not inferred:** the `pcx-` peering id, the NAT Gateway's Elastic IP, the
frontend's public IPv4, and the `curl` timings before and after the routes existed. Those four are
blank because they were not seen, which is the same rule `evidence.md` runs on.

---

## 3. What the lab gets right

Worth writing down separately, because the list of errors below is longer and would otherwise read
as a dismissal.

- **The demo actually depends on the peering.** The frontend's request to the backend is issued by
  the frontend's *server process*, not by the visitor's browser. A browser-side call would traverse
  the public internet and work with no peering at all, which is how a large number of peering
  tutorials accidentally prove nothing.
- **Teardown terminates instances first.** The network interface is the root of nearly every
  dependency failure in a VPC delete, and the lab removes it first.
- **It deletes the Instance Connect Endpoint before the security group**, which is the same
  constraint one step removed — the endpoint holds an interface too.
- **It uses the *delete related routes* option** when removing the peering, instead of leaving
  `blackhole` entries behind by hand.
- **It relies on the VPC delete cascading** to subnets, internet gateway, route tables, NACLs and
  remaining security groups. True, and it saves a dozen steps — though the lab never says it is
  happening.

---

## 4. What goes to the write-up as errors

### Addressing

**`9.255.0.0/16` is publicly assigned space.** Not RFC 1918. It appears to have been chosen only to
avoid colliding with the `10.0.0.0/16` the lab had already spent on the backend. Using a range that
belongs to someone else, inside a teaching lab about addressing, is the error that propagates
furthest: a student who copies it into a real account has built a VPC that can never reach the real
owner of those addresses.

**`10.0.0.0/16` for the backend** is the console wizard's default, and
[ADR-0003](../docs/adr/0003-repo-wide-ipv4-addressing-plan.md) exists in this repository
specifically because that default, chosen per module, leaves every VPC identical and nothing
peerable. The lab demonstrates the trap by falling into it one VPC later.

### The central claim

**"As if they were in the same VPC" is false in five ways,** none of which the lab mentions:

1. Peering is **not transitive** — A↔B and B↔C does not give A↔C.
2. **No edge-to-edge routing** — a peer cannot reach the other side's internet gateway, NAT
   gateway, VPC endpoints, or VPN/Direct Connect attachments.
3. **No cross-region security-group references** — a rule in one VPC cannot name a group in the
   other, so the rule has to fall back to a CIDR. This repository treats
   group-by-identity as the default ([ADR-0015](../docs/adr/0015-reference-security-groups-by-identity.md)),
   and peering is where that default stops being available.
4. **Private DNS resolution across the peering is off by default** — the hostname does not resolve
   to the private address until both sides enable it.
5. **MTU across a peering is 1500**, not the 9001 an intra-VPC path allows. Jumbo frames stop at
   the peering.

### Routing, which is the pedagogical centre and is handled worst

**Both routes are created in one step,** so the asymmetric failure never happens and never gets
explained. That failure is the real lesson: with a route on one side only, the SYN arrives and the
SYN-ACK dies — in this lab, out through the backend's NAT Gateway. The client sees a timeout, which
is indistinguishable from a closed port, a wrong address or a missing security-group rule. Module 3
splits this into two steps for exactly this reason (plan §5, P1).

**The final verification explains the two routes backwards.** It says the backend's route table
"receives requests". A route table directs outbound traffic only: the frontend's route carries the
request, the backend's route carries the reply. With the roles reversed, the asymmetric failure
above cannot be explained at all.

### Security groups

Both VPCs open **22 and 3000 to `0.0.0.0/0`**. Port 22 is open on an instance the lab reaches
through Instance Connect — which is the mechanism that makes an open 22 unnecessary — and 3000 is
open to the internet on the *backend*, whose entire premise is that it is private. The only rule the
peering required anyone to think about is **3000 from the frontend's CIDR**, inbound, on the
backend. That single rule is the lesson, and it is buried under two that should not exist.

### The application layer

- **Node 16, from an external repository.** Out of support, and an external dependency that
  [ADR-0002](../docs/adr/0002-self-contained-repository.md) would refuse.
- **Interactive foreground deploy.** The process dies with the SSH session, which interacts badly
  with the next item.
- **The Instance Connect tunnel is capped at 3600 s** (observed on `eice-0bec41f11c1ca5f2b`). A
  session that ends takes the foreground app with it, so the backend can stop answering before the
  verification step runs — and the symptom is a frontend page that went blank, which looks exactly
  like a routing failure.

### Cleanup — the most expensive omission in the lab

**The Elastic IP is never released.** The lab deletes the NAT Gateway and stops. The address the
wizard allocated in task 1 detaches and stays in the account, billing hourly as an unassociated
public IPv4 — and deleting the VPC does not reclaim it, because Elastic IPs are not VPC resources.
In the sandbox this is invisible; *End Lab* destroys the account. In a real account it is the
classic leak that shows up on next month's bill.

Missing step, after the NAT: **VPC → Elastic IPs → select → Release**, then confirm the unfiltered
list is empty **in both regions**.

Module 3 removes this failure mode by construction rather than by remembering it: no NAT Gateway, so
no Elastic IP to leak (plan §6). The sweep still runs anyway.

### Cleanup — three waits the lab does not mention

1. **A security group cannot be deleted while a network interface still uses it.** An instance in
   `shutting-down` still has its interface, and the Instance Connect Endpoint has one carrying the
   same group — the lab reuses it. A failed security-group delete is almost always an interface
   that has not gone yet, not a mistake by the person clicking.
2. **A NAT Gateway takes minutes to go from `deleting` to `deleted`,** and its interface stays in
   the public subnet throughout. A VPC delete inside that window fails on dependencies.
3. **Deleting the peering with *delete related routes* produces an error, and the lab says to ignore
   it.** The cause is specific: the Virginia console deletes Virginia's route and cannot touch
   Ohio's, because a regional console does not edit another region's route tables. Ohio's entry
   stays in `blackhole` until that VPC is deleted. Telling a student to ignore it is the worst
   available choice, because in two separate accounts nobody deletes the other side's VPC and the
   blackhole is permanent.

### Corrected order, for a real account

Routes removed by hand in both regions → peering → instances to `terminated` → Instance Connect
Endpoints gone → NAT to `deleted` → **release the Elastic IP** → security groups → both VPCs →
final unfiltered sweep of Elastic IPs, NAT Gateways, peering connections and `available` EBS
volumes, **in both regions**.

---

## 5. Cost of running the lab in a real account

Roughly two hours of NAT Gateway plus its Elastic IP, two `t3.micro`, and inter-region data
transfer that is negligible at this volume. **The NAT Gateway is more than 80% of it** — which is
the measurement that drives module 3's decision to declare none. Exact prices to be verified on the
day, not carried from here.

---

## 6. What module 3 took, and what it changed

| Lab | Module 3 | Where it is argued |
|---|---|---|
| `10.0.0.0/16` + `9.255.0.0/16` | `10.1.0.0/16`, `10.2.0.0/16`, `10.3.0.0/16` | plan §3, ADR-0003 |
| Two VPCs | Three — the third is the non-transitivity finding | plan §3 |
| Both routes in one step | One route, measured, then the second | plan §5 P1 |
| Peering requested from the backend | Requested from the side that avoids a cross-region reference cycle | plan §4 |
| NAT Gateway, for `yum` | No NAT, no internet, no Elastic IP | plan §6 |
| Node 16 proxy on port 3000 | A TCP probe using only what the AMI ships | plan §5 |
| 22 and 3000 open to `0.0.0.0/0` | The one rule the peering requires, by CIDR | plan §8 |
| Timeout as the only observation | A flow log, so a drop is readable | plan §5 E3, ADR-0035 |
