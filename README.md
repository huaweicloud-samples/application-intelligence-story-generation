# application-intelligence-story-generation / Nightly Bedtime Story Generator

[![License](https://img.shields.io/badge/License-MIT%20No%20Attribution-blue.svg)](LICENSE)
[![Huawei Cloud](https://img.shields.io/badge/Huawei%20Cloud-IAM%20Auth-red.svg)](https://support.huaweicloud.com/intl/en-us/)
[![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen.svg)](#)

> Event-driven nightly bedtime story generation with voice synthesis and email notification on Huawei Cloud

---

## 1. Overview

This practice provides a scheduled content generation system running on Huawei Cloud: at a fixed time every day, a large model automatically generates a children's bedtime story, persists it with a 2-day TTL, and fans out a domain event to two asynchronous pipelines (speech synthesis and email notification). A NextJS SSR frontend renders the story on demand and plays the audio. It is intended for DevOps / backend engineers as a reference architecture and learning sample for event-driven architecture (EDA) and serverless content generation.

### Core Capabilities

- **Scheduled generation**: a FunctionGraph timer trigger invokes the MaaS preset model (DeepSeek by default) at 19:15 every day
- **Domain event fan-out**: the StoryGenerated event is routed one-to-many by EventGrid (EG)
- **Asynchronous multimodal processing**: SIS speech synthesis produces MP3 audio (played via OBS presigned URL); SMN sends the email notification
- **Data lifecycle**: the stories table uses DynamoDB-compatible TTL with automatic 2-day expiry
- **Containerized frontend**: NextJS SSR application on Cloud Application Engine (CAE), degrading gracefully when audio is not ready yet

---

## 2. Table of Contents

- [1. Overview](#1-overview)
- [2. Table of Contents](#2-table-of-contents)
- [3. Architecture](#3-architecture)
- [4. Highlights](#4-highlights)
- [5. Huawei Cloud Services](#5-huawei-cloud-services)
- [6. Prerequisites](#6-prerequisites)
- [7. Quick Start](#7-quick-start)
- [8. Step-by-Step Deployment](#8-step-by-step-deployment)
- [9. Usage / Verification](#9-usage--verification)
- [10. Cleanup](#10-cleanup)
- [11. Detailed Description](#11-detailed-description)
- [12. Dependencies](#12-dependencies)
- [13. FAQ / Troubleshooting](#13-faq--troubleshooting)
- [14. Contributing](#14-contributing)
- [15. License](#15-license)
- [16. Contact / Maintainers](#16-contact--maintainers)

---

## 3. Architecture

> Scheduled trigger → model generation → domain event fan-out → asynchronous multimodal processing

See [docs/architecture.md](docs/architecture.md) for the full architecture diagram and data flow.

```
                            ┌────────────┐
                            │   Timer    │
                            └──────┬─────┘
                                   │ daily 19:15
                                   ▼
┌────────────────────────────────────────────────────────────────────┐
│                    FunctionGraph  create-story                     │
│   read characters/scenes, call MaaS, write stories (TTL 2 days)    │
└───────────────┬─────────────────────────────────────┬──────────────┘
                │ write stories                       │ publish event
                ▼                                     ▼
┌──────────────────────────────┐      ┌──────────────────────────────┐
│   GeminiDB compatible API    │      │         EG EventGrid         │
│characters / scenes / stories │      │ custom event source + 2 subs │
│       TTL auto cleanup       │      │     routes by event type     │
└───────────────┬──────────────┘      └───────────────┬──────────────┘
                │                                     │
                │                             ┌───────┴───────┐
                │                             │               │
                │                             ▼               ▼
                │                      ┌─────────────┐ ┌─────────────┐
                │                      │  generate   │ │  SMN email  │
                │                      │ audio func  │ │ story link  │
                │                      │ SIS TTS MP3 │ │+ /story?id= │
                │                      └──────┬──────┘ └──────┬──────┘
                │                             │               │
                │                             ▼               ▼
                │                      ┌─────────────┐ ┌─────────────┐
                │                      │  OBS audio  │ │User mailbox │
                │                      │presigned URL│ │open the link│
                │                      └──────┬──────┘ └──────┬──────┘
                │
                │ read stories                │ play audio    │ open
                ▼                             ▼               ▼
┌────────────────────────────────────────────────────────────────────┐
│                   CAE frontend app (NextJS SSR)                    │
│     GET /          GET /story?id=...          GET /api/health      │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │
                                   ▼
                            ┌────────────┐
                            │  Browser   │
                            └────────────┘

audioURL written back to stories, CAE reads story and plays audio
```

---

## 4. Highlights

- **Fully event-driven**: the story generation emits a domain event on completion; the audio and email pipelines run independently and can scale separately
- **Serverless-first**: all compute runs on pay-per-use functions (FunctionGraph); the frontend is a container application on CAE — no servers to manage
- **Model-as-a-Service**: uses ModelArts Studio preset models via an OpenAI-compatible API, billed by token, no self-hosted inference
- **Automatic data expiry**: stories expire via a 2-day TTL — no manual housekeeping
- **Managed secrets**: the model API Key is stored in DEW-CSMS and read at function runtime

---

## 5. Huawei Cloud Services

| Service | Purpose | Notes |
|---|---|---|
| FunctionGraph | create-story / generate-audio functions + timer / event triggers | Node.js 18 runtime |
| GeminiDB (DynamoDB-compatible) | characters / scenes / stories tables | single node by default, scalable via variable |
| OBS | private audio bucket | playback via presigned URLs |
| EventGrid (EG) | custom event source + two subscriptions | one-to-many event routing |
| SMN | story email notification topic | email subscription confirmation required |
| SIS speech synthesis | text to MP3 audio | segmented short-form synthesis |
| MaaS (ModelArts Studio) | story text generation | preset models, pay-per-token |
| DEW-CSMS | model API Key storage | read at function runtime |
| CAE | NextJS SSR frontend container application | with an EIP public entry |
| VPC / IAM | network isolation / service agencies | — |

> **Tip**: all services are provisioned by the Terraform in this repository; see [Section 10 "Cleanup"](#10-cleanup) to release them.

---

## 6. Prerequisites

| Item | Requirement | Notes |
|---|---|---|
| **Account** | A verified Huawei Cloud account | personal or enterprise |
| **Permissions** | IAM **Tenant Administrator** or equivalent | required to create VPC / GeminiDB / CAE resources |
| **Region** | `cn-north-4` recommended | all services above must be available; MaaS preset services are region-limited but the inference entry is a public endpoint that can differ from the resource region |
| **MaaS** | Preset service enabled and an API Key created | Console ModelArts → `#/model-studio/homepage` |
| **Terraform** | `>= 1.5.0` | IaC tool |
| **huaweicloud Provider** | `>= 1.97.0` | Huawei Cloud Terraform Provider |
| **Node.js / Docker** | Node 18+, Docker | function packaging, frontend image build (**no obsutil needed**: packages are uploaded inline as base64) |
| **AK/SK** | Obtain the Access Key from the Huawei Cloud "My Credentials" page and export it in the deployment terminal | **never** write credentials into code or configuration files |

---

## 7. Quick Start

```bash
# 1. Clone this repository
git clone <repo-https-url> application-intelligence-story-generation
cd application-intelligence-story-generation

# 2. Prepare credentials (see [Prerequisites](#6-prerequisites))
export HW_ACCESS_KEY="<your-access-key>"
export HW_SECRET_KEY="<your-secret-key>"

# 3. Build the function deployment packages
node scripts/build-packages.js

# 4. Deploy (see [deployment guide](docs/deployment-guide.md))
cd infra
cp terraform.tfvars.example terraform.tfvars   # fill in password / MaaS key / email / image URL
terraform init && terraform plan && terraform apply -auto-approve
```

> **Deployment time**: about 15-25 minutes (dominated by the GeminiDB instance).
> **The function deployment packages must be built first**: see [Section 8](#8-step-by-step-deployment) and [docs/deployment-guide.md](docs/deployment-guide.md).

---

## 8. Step-by-Step Deployment

### Step 1: Initialize

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # edit with real values
terraform init
```

**Expected output**: `Terraform has been successfully initialized!`

### Step 2: Build the function deployment packages

```bash
cd ..
node scripts/build-packages.js
```

**Expected output**:

```
==> building function packages
  create_story.zip: 9194 files, 9.02 MB
  generate_audio.zip: 6494 files, 6.48 MB
==> done. total 15.50 MB (FGS inline limit 50 MB per package)
```

> Packages are uploaded inline as base64 (`code_type = "zip"`), so no obsutil and no manual OBS upload are needed.

### Step 3: Build and push the frontend image

```bash
cd src/frontend
docker build -t <swr-domain>/<org>/story-frontend:1.0.0 .
docker push <swr-domain>/<org>/story-frontend:1.0.0
```

**Expected output**: the image appears under the organization in SWR.

### Step 4: Full deployment

```bash
cd ../../infra
terraform plan
terraform apply -auto-approve
```

**Expected output**: `Apply complete! Resources: N added, 0 changed, 0 destroyed.`

### Step 5: Post-deployment

1. Configure `HW_ACCESS_KEY` / `HW_SECRET_KEY` environment variables (encrypted recommended) for both functions in the FunctionGraph console
2. Confirm the SMN email subscription from the mailbox
3. Import seed data (commands in [docs/deployment-guide.md](docs/deployment-guide.md) §5; expected output `seed data inserted`)
4. Configure the EIP public access for the CAE component in the console and write the access URL back to the `STORY_FRONTEND_URL` environment variable of `create-story`

---

## 9. Usage / Verification

> **Mandatory verification**: the commands / samples in this section have been executed by the agent before delivery and behave as described. Please walk through them yourself and confirm the business functionality before considering the delivery complete.

### Verification 1: Trigger story generation manually

Open the `create-story` function in the FunctionGraph console → "Test" tab → create an empty test event `{}` → click "Test".

**Expected output**:

```json
{
  "statusCode": 200,
  "body": "{\"id\":\"<uuid>\",\"title\":\"<story title>\"}"
}
```

### Verification 2: Story persisted

Check the stories table in the GeminiDB console (or via a compatible client), or check the function logs for a successful write.

**Expected result**: a new item exists in the stories table with `ttl` = write time + 172800 seconds.

### Verification 3: Event fan-out and email

After `create-story` finishes, check that `generate-audio` was triggered automatically by EG (logs show the `audioURL` write-back), and that the mailbox received an email from the `New bedtime story notifications` topic.

**Expected result**: the email body contains the frontend story page URL `/story?id=<uuid>`.

### Verification 4: End-to-end

Open the story page from the email: `https://<cae-domain>/story?id=<uuid>`.

**Expected result**: the page shows the story title and text; after a few tens of seconds a refresh reveals a working audio player.

> After deployment, please walk through this section yourself and confirm the business functionality before considering the delivery complete.

---

## 10. Cleanup

```bash
cd infra
terraform destroy -auto-approve
```

**Expected output**: `Destroy complete! Resources: N destroyed.`

> **Avoid leftovers**:
> - `terraform destroy` only releases resources tracked in the Terraform state;
> - the frontend image in SWR and manually created access configurations in the CAE console must be released manually;
> - the local deployment packages under `build/` can be deleted directly (not tracked in git).

---

## 11. Detailed Description

### Workflow

1. The timer trigger invokes create-story at 19:15 every day.
2. create-story reads all characters and scenes, picks a random scene, builds a prompt, generates the story via MaaS (title + 200-word rhyming text), and writes it into the stories table (uuid primary key, ttl = 2 days).
3. On successful write, a StoryGenerated domain event is published to the EG custom event source.
4. Two EG subscriptions deliver the event to the generate-audio function and the SMN email topic respectively.
5. generate-audio calls SIS short-form speech synthesis per sentence segment, concatenates the MP3 bytes, uploads to OBS, generates a 2-day presigned URL and writes it back to stories.audioURL.
6. The user opens `/story?id=<uuid>` from the email; the frontend reads the story from the stories table and degrades to text-only when audio is not ready.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `region` | `cn-north-4` | resource region |
| `geminidb_node_num` | `1` | GeminiDB node count, >= 3 recommended for production |
| `geminidb_flavor` | `geminidb.cassandra.xlarge.4` | GeminiDB node flavor |
| `bedtime_cron` | `0 15 19 * * * *` | timer expression (second minute hour day month week year) |
| `maas_chat_model` | `deepseek-v3.2` | MaaS preset model deployment name |
| `notify_email` | — | email subscription address (required) |
| `swr_image` | — | frontend image URL (required) |

### Tables

| Table | Primary key | Key fields | Lifecycle |
|---|---|---|---|
| characters | id | name, description | seed data, long-lived |
| scenes | id | description | seed data, long-lived |
| stories | id | title, description, scene, audioURL, ttl | 2-day TTL auto expiry |

---

## 12. Dependencies

| Name | Version | Purpose |
|---|---|---|
| Terraform | `>= 1.5.0` | IaC orchestration |
| huaweicloud Provider | `>= 1.97.0` | Huawei Cloud resources |
| Node.js | `18.x` | function runtime |
| @aws-sdk/client-dynamodb | `^3.500.0` | GeminiDB DynamoDB-compatible client (protocol-compatible SDK) |
| esdk-obs-nodejs | `^3.24.3` | OBS upload and presigned URLs |
| openai | `^4.50.0` | MaaS OpenAI-compatible invocation |
| @huaweicloud/huaweicloud-sdk-* | `^3.1.100` | CSMS / EG / SIS SDKs |

---

## 13. FAQ / Troubleshooting

### Q1: "Insufficient permissions" during deployment

**A**: make sure the account has IAM **Tenant Administrator**, or at least VPC Administrator, GeminiDB Administrator, FunctionGraph FullAccess, CAE Administrator, SMN FullAccess, EG FullAccess, SIS FullAccess, DEW FullAccess.

### Q2: MaaS returns `ModelArts.81004` or an auth error

**A**: confirm MaaS is enabled and the API Key is valid (shown only once at creation); `maas_chat_model` must be a preset deployment name in lowercase; the unified entry is `https://api.modelarts-maas.com/v2`.

### Q3: No email received

**A**: confirm the SMN subscription confirmation email was clicked; check the delivery records of the EG subscriptions; verify `notify_email`.

### Troubleshooting checklist

| Symptom | Likely cause | How to check |
|---|---|---|
| create-story database connection error | GEMINIDB_ENDPOINT missing port or credentials missing | ensure the env var contains `:8000` and `HW_ACCESS_KEY/HW_SECRET_KEY` are set |
| generate-audio not triggered | EG subscription inactive or filter mismatch | verify the event source name and subscription status in the EG console |
| Blank frontend page | CAE component env vars missing | verify `TABLE_NAME` / `GEMINIDB_ENDPOINT` |
| Audio not playable | presigned URL expired (2 days) | trigger a new story generation |

---

## 14. Contributing

Issues and PRs are welcome:

1. **Issue**: describe the problem / suggestion (with reproduction commands, expected vs actual output, screenshots)
2. **PR**: create a feature branch from `main`; run `terraform validate` and `terraform fmt -check` before submitting
3. **Code Review**: merged after approval by **[@<github-username>](https://github.com/<github-username>)**

---

## 15. License

This practice is released under the **MIT No Attribution** license. See [`LICENSE`](LICENSE).

```
MIT No Attribution

Copyright (c) Huawei Cloud

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software... (no attribution required)
```

---

## 16. Contact / Maintainers

| Item | Content |
|---|---|
| **Creator** | [@<github-username>](https://github.com/<github-username>) |
| **Maintainer** | [@<github-username>](https://github.com/<github-username>) |
| **Contact** | GitHub Issues / PRs (see [Section 14](#14-contributing)) |

---
