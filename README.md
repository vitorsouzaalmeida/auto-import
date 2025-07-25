# TS Import Check

Detect missing imports and suggest them automatically using TypeScript API. Built for my use cases

## What it does

Analyzes files and suggests missing imports by leveraging TypeScript's Language Service API.

```bash
$ bun run index.ts example.tsx

Analyzing: example.tsx

[TS] useState import suggestion:
   import { useState } from "react";

[TS] useEffect import suggestion:
   import { useEffect } from "react";

[TS] motion import suggestion:
   import { motion } from "motion/react";

[TS] Grouped suggestions:
   import { useState, useEffect } from "react";
   import { motion } from "motion/react";
```

## Installation

```bash
bun install
```

## Usage

```bash
bun run c example.tsx
```