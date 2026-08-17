#!/usr/bin/env python3
"""Regenerate hapvida-prod-topology.drawio.

Editable draw.io using the official AWS Architecture Icons (draw.io ships
them as mxgraph.aws4.*). Run: python3 gen-topology-drawio.py

NOT generic: every identifier below is hapvida's, hardcoded. It exists so
the drawing can be UPDATED rather than redrawn, which is the difference
between a diagram that tracks reality and one that quietly stops being
true — the same failure the hapvida report already had once.

The drawing is a SNAPSHOT. `make aws-preflight CLIENT=hapvida` is the live
answer and the only one to trust when they disagree.
"""
import html
import pathlib

cells = []


def esc(s):
    return html.escape(s, quote=True)


def node(id_, label, style, x, y, w, h, parent="1"):
    cells.append(
        f'<mxCell id="{id_}" value="{esc(label)}" style="{style}" vertex="1" parent="{parent}">'
        f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>'
    )
    return id_


def edge(id_, src, dst, label="", style=""):
    base = ("edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;jettySize=auto;orthogonalLoop=1;"
            "fontSize=10;fontColor=#5A6B80;strokeColor=#5A6B80;strokeWidth=1.4;endArrow=blockThin;endFill=1;")
    cells.append(
        f'<mxCell id="{id_}" value="{esc(label)}" style="{base}{style}" edge="1" '
        f'parent="1" source="{src}" target="{dst}"><mxGeometry relative="1" as="geometry"/></mxCell>'
    )


# ── group styles (official AWS group shapes) ────────────────────────────────
def group(gr_icon, stroke, fill="none", dashed=0, font=None):
    return (
        "points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],"
        "[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];"
        "outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;"
        "container=1;pointerEvents=0;collapsible=0;recursiveResize=0;"
        f"shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.{gr_icon};"
        f"strokeColor={stroke};fillColor={fill};dashed={dashed};verticalAlign=top;align=left;"
        f"spacingLeft=30;fontColor={font or stroke};"
    )


def res(res_icon, fill):
    """A resource icon tile — label sits under the icon, AWS house style."""
    return (
        "sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=" + fill + ";"
        "strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;"
        "html=1;fontSize=10;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.resourceIcon;"
        f"resIcon=mxgraph.aws4.{res_icon};"
    )


def note(stroke="#5A6B80", fill="#FFFFFF", dashed=0):
    return (
        "rounded=1;arcSize=6;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacing=6;"
        f"fontSize=10;fontColor=#232F3E;strokeColor={stroke};fillColor={fill};dashed={dashed};"
    )


C_COMPUTE, C_NET, C_STORAGE = "#ED7100", "#8C4FFF", "#7AA116"
C_SEC, C_INT, C_DB = "#DD344C", "#E7157B", "#C925D1"
C_REGION = "#00A4A6"

# ── containment ─────────────────────────────────────────────────────────────
node("cloud", "AWS Cloud  ·  504557607647  ·  SHARED with usage-main and khal-web-desktop",
     group("group_aws_cloud", "#232F3E"), 20, 20, 1640, 1180)
node("region", "Region  ·  sa-east-1  (São Paulo)",
     group("group_region", C_REGION, dashed=1), 40, 60, 1600, 1120, "cloud")

node("vpc", "VPC  ·  khal-hapvida-prod-usage-vpc  ·  vpc-0b74286babe62ad81  ·  10.80.0.0/16",
     group("group_vpc2", C_NET), 30, 50, 1180, 810, "region")

node("alb", "Application Load Balancer  ·  khal-hapvida-prod-usage\n"
            ":80 → 301  ·  :443 TLS (ACM, ISSUED) default fixed-404  ·  host rules 100 / 101\n"
            "TG api :3000 /api/v1/docs  ·  TG lw :5560 /",
     note(C_NET, "#F7F3FF"), 30, 40, 1120, 54, "vpc")

node("az1", "Availability Zone  sa-east-1a",
     group("group_availability_zone", C_REGION, dashed=1), 30, 116, 550, 480, "vpc")
node("az2", "Availability Zone  sa-east-1b",
     group("group_availability_zone", C_REGION, dashed=1), 600, 116, 550, 480, "vpc")

node("pub1", "Public subnet  ·  10.80.0.0/24  ·  subnet-04dbf92dc3613f8b7",
     group("group_public_subnet", C_STORAGE, "#F2F8E9"), 16, 36, 518, 130, "az1")
node("pub2", "Public subnet  ·  10.80.1.0/24  ·  subnet-077134ca9db111d7e",
     group("group_public_subnet", C_STORAGE, "#F2F8E9"), 16, 36, 518, 130, "az2")
node("prv1", "Private subnet  ·  10.80.10.0/24  ·  subnet-012734b0c52085343",
     group("group_private_subnet", "#00A4BF", "#EAF6FA"), 16, 182, 518, 282, "az1")
node("prv2", "Private subnet  ·  10.80.11.0/24  ·  subnet-0da44737c1a155aaa",
     group("group_private_subnet", "#00A4BF", "#EAF6FA"), 16, 182, 518, 282, "az2")

# ── in the public subnets ───────────────────────────────────────────────────
node("nat", "NAT Gateway\nnat-0b499e818c7733537\nEIP 54.233.226.42 (Atlas allowlist)", res("nat_gateway", C_NET),
     30, 44, 48, 48, "pub1")
node("natnote", "The tenant's stable egress IP —\nthe address Atlas allowlists",
     note("#CBD5E1", "#FFFFFF"), 190, 46, 300, 44, "pub1")
node("albn2", "ALB node", res("elastic_load_balancing", C_NET), 30, 44, 48, 48, "pub2")

# ── in the private subnets ──────────────────────────────────────────────────
node("ec2lw", "EC2 · LangWatch\ni-0b76d98a6cf43a869 · 10.80.10.252\nt3.xlarge · gp3 50 GB ENCRYPTED",
     res("ec2", C_COMPUTE), 30, 44, 48, 48, "prv1")
node("lwstack", "LangWatch stack (docker compose) — RUNNING\ncaddy embed proxy :5560  ·  app  ·  workers ×2\n"
                "redis  ·  postgres  ·  ClickHouse :8123\nclickhouse.hapvida.internal.usage",
     note("#B45309", "#FFF7ED"), 130, 40, 360, 78, "prv1")
node("eni1", "Atlas PrivateLink ENI\n10.80.10.234", res("endpoints", C_DB), 30, 168, 48, 48, "prv1")

node("ecs", "ECS Fargate  ·  cluster khal-hapvida-prod-usage",
     group("group_security_group", C_COMPUTE, "#FFF6EE"), 20, 40, 480, 130, "prv2")
node("svcapi", "api · RUNNING\n256/512 · :3000\nautoscale 1–4", res("fargate", C_COMPUTE), 24, 44, 44, 44, "ecs")
node("svccon", "connector · RUNNING\ndesired 1 · 0/100\nSINGLETON", res("fargate", C_COMPUTE), 176, 44, 44, 44, "ecs")
node("svcsch", "scheduler · RUNNING\ndesired 1 · 0/100\nSINGLETON", res("fargate", C_COMPUTE), 328, 44, 44, 44, "ecs")
node("eni2", "Atlas PrivateLink ENI\n10.80.11.161", res("endpoints", C_DB), 30, 200, 48, 48, "prv2")

# ── VPC-level endpoints ─────────────────────────────────────────────────────
node("igw", "Internet Gateway\nigw-08accaed240139631", res("internet_gateway", C_NET), 40, 630, 48, 48, "vpc")
node("s3ep", "S3 Gateway endpoint\nvpce-0230792e416279458", res("endpoints", C_STORAGE), 300, 630, 48, 48, "vpc")
node("plink", "Atlas PrivateLink\nvpce-0f5ce96c31e2e8ab8\nSG 1024–65535", res("privatelink", C_DB),
     560, 630, 48, 48, "vpc")
node("sgnote", "Security groups\nalb sg-0d5b26434f6b64bd2 · api sg-0dc125a873f560ab0\n"
               "workers sg-03d81bd8d4a2ba068 · langwatch sg-07ac8fd9551026737\n"
               "atlas sg-0fb4a32493a79f419  (1024–65535, not 27017)",
     note(C_SEC, "#FEF2F4"), 760, 616, 390, 76, "vpc")

# ── regional services, outside the VPC ──────────────────────────────────────
node("regional", "Regional services — outside the VPC",
     group("group_security_group", "#232F3E", "#F7F9FB"), 1230, 50, 350, 810, "region")

ry = 44
for rid, lbl, icon, colour in [
    ("ecr", "ECR × 3 — pushed by CI\nmodule · connector · db-backup\nIMMUTABLE · SHA 3acc689",
     "elastic_container_registry", C_COMPUTE),
    ("s3", "S3 backups\n…-backups-504557607647-sa-east-1-an\nlifecycle scoped to backups/ ONLY",
     "simple_storage_service", C_STORAGE),
    ("sm", "Secrets Manager × 2\nkhal/hapvida/prod/usage/{mongo,langwatch}",
     "secrets_manager", C_SEC),
    ("ssm", "SSM × 2\nlangwatch-project-id · langwatch-capacity",
     "systems_manager", C_INT),
    ("logs", "CloudWatch Logs × 4 + 2 alarms\n90-day retention · missing data BREACHES",
     "cloudwatch_2", C_INT),
    ("sns", "SNS → Chatbot → Slack\nkhal-hapvida-prod-usage-alerts\nguardrail AWSDenyAll",
     "simple_notification_service", C_INT),
    ("sched", "EventBridge Scheduler — ENABLED\nbackup cron(0 7 * * ? *)\nrevision-less family ARN",
     "eventbridge", C_INT),
    ("iam", "IAM × 9 roles\ngithub-ci (zero Create*) · audit (no GetSecretValue)\n"
            "execution · task · backup-task · backup-schedule · langwatch · dlm · chatbot",
     "identity_and_access_management", C_SEC),
    ("r53", "Route 53 public zone — UNUSED, delete\nDNS lives in Cloudflare",
     "route_53", C_NET),
    ("acm", "ACM certificate — ISSUED\n*.hapvida.khal.ai + apex · to 01/03/2027",
     "certificate_manager", C_SEC),
]:
    node(rid, lbl, res(icon, colour), 26, ry, 44, 44, "regional")
    ry += 78

# ── outside the account ─────────────────────────────────────────────────────
node("gha", "GitHub Actions\nkhal-os/usage-component\nOIDC only — no stored keys\n"
            "build-images · deploy-tenant · fleet-heartbeat",
     note("#5A6B80", "#F4F6F9"), 40, 1230, 330, 84)
node("atlas", "MongoDB Atlas\nproduction-pl-0.7dwf4x.mongodb.net\n"
              "M10 sa-east-1 · Cloud Backup + PIT\nhapvida_machine_db_user → usage_db",
     note(C_DB, "#FDF2FE"), 420, 1230, 330, 84)
node("zone", "khal.ai zone — Cloudflare, proxy OFF\n3 CNAMEs: ACM validation (permanent),\n"
             "api. and langwatch. → the ALB\nNO NS delegation: it would shadow them all",
     note("#5A6B80", "#F4F6F9"), 800, 1230, 340, 84)
node("agents", "Client agent platform\nOTLP → langwatch.hapvida.khal.ai",
     note("#5A6B80", "#F4F6F9"), 1190, 1230, 300, 84)

# ── flows ───────────────────────────────────────────────────────────────────
edge("e1", "agents", "alb", "OTLP over :443")
edge("e2", "alb", "svcapi", "host rule 100 → TG api")
edge("e3", "svccon", "lwstack", "reads ClickHouse :8123")
edge("e4", "svcapi", "plink", "")
edge("e5", "plink", "atlas", "PrivateLink — no public route",
     "dashed=1;strokeColor=#C925D1;fontColor=#C925D1;")
edge("e6", "gha", "ecr", "push images", "strokeColor=#B45309;fontColor=#B45309;")
edge("e7", "gha", "ecs", "register task defs + roll services",
     "strokeColor=#B45309;fontColor=#B45309;")
edge("e8", "gha", "s3", "publish config bundle", "strokeColor=#B45309;fontColor=#B45309;")
edge("e9", "sched", "ecs", "RunTask backup 07:00 UTC")
edge("e10", "s3", "ec2lw", "box refetches config on every start",
     "dashed=1;")
edge("e11", "nat", "atlas", "egress 54.233.226.42 (allowlist)", "dashed=1;")
edge("e12", "zone", "acm", "validation CNAME — permanent", "dashed=1;")

legend = (
    "LEGEND    Everything below is LIVE — 58 resources verified by preflight-aws.sh (0 failures).\n"
    "Category colours are the AWS Architecture Icons palette: orange compute · purple networking · "
    "green storage · red security · pink management · magenta database.\n"
    "CD may create NOTHING here. It only puts artifacts into stores infra created: images into ECR, "
    "task-definition revisions into ECS, the config bundle into s3://…/config/hapvida/, "
    "the capacity JSON into SSM."
)
node("legend", legend, note("#232F3E", "#FFFFFF"), 40, 1350, 1450, 76)
node("title", "Hapvida · prod — Khal OS usage component\n"
              "account 504557607647 · sa-east-1 · hapvida.khal.ai · fully deployed 16 Aug 2026",
     "text;html=1;align=left;verticalAlign=middle;fontSize=16;fontStyle=1;fontColor=#232F3E;",
     40, 1440, 800, 40)

xml = (
    '<mxfile host="app.diagrams.net" agent="khal-usage-component" version="24.7.17">\n'
    '  <diagram id="hapvida-prod" name="hapvida · prod">\n'
    '    <mxGraphModel dx="1600" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" '
    'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1700" pageHeight="1500" '
    'math="0" shadow="0">\n'
    '      <root>\n'
    '        <mxCell id="0"/>\n'
    '        <mxCell id="1" parent="0"/>\n'
    + "\n".join("        " + c for c in cells) + "\n"
    '      </root>\n'
    '    </mxGraphModel>\n'
    '  </diagram>\n'
    '</mxfile>\n'
)

out = pathlib.Path("hapvida-prod-topology.drawio")
out.write_text(xml, encoding="utf-8")
print("wrote", out, out.stat().st_size, "bytes,", len(cells), "cells")
