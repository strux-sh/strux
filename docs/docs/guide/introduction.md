# Introduction

Strux OS is a framework for building **kiosk-style Linux operating systems**. You write a web frontend and a Go backend; Strux turns them into a complete, bootable OS image for your target hardware — kernel, bootloader, and all — with a single command.

## What do you mean, "an operating system"?

When you build a kiosk, digital sign, point-of-sale terminal, or museum exhibit, you don't want a desktop Linux install with your app on top. You want a device that powers on, shows your app full-screen, and does nothing else — no desktop, no notifications, no update popups, nothing for a user to break out of.

Strux builds exactly that: a minimal Debian-based Linux image where your app **is** the entire user interface. The device boots straight from your splash logo into your frontend.

## The stack

A Strux device runs a small, fixed stack:

```txt
┌─────────────────────────────────────────┐
│  Your web frontend (React / Vue / JS)   │  ← what the user sees
├─────────────────────────────────────────┤
│  WPE WebKit (embedded browser engine)   │  ← renders it full-screen
├─────────────────────────────────────────┤
│  Cage (Wayland compositor)              │  ← puts it on the display
├─────────────────────────────────────────┤
│  Your Go application + Strux runtime    │  ← hardware, system APIs, logic
├─────────────────────────────────────────┤
│  Minimal Debian Linux + systemd         │  ← the OS Strux builds for you
└─────────────────────────────────────────┘
```

::: tip New to some of these terms?
A **Wayland compositor** is the Linux component that draws windows on a screen — Cage is a tiny one that shows a single app full-screen and nothing else. **WPE WebKit** is a browser engine built for embedded devices: all of the rendering, none of the browser UI.
:::

You write two things:

- **The frontend** — a normal web app. Use React, Vue, or vanilla JavaScript with Vite. If you've built a web app, you already know how to do this.
- **The backend** — a Go program using the Strux runtime library. It handles everything a browser can't: talking to hardware, managing the network, controlling displays, applying OS updates. Your frontend calls it through an automatically generated, fully typed API.

Strux handles everything else: cross-compiling for your target board, building the kernel and bootloader, assembling the root filesystem, and producing a flashable image.

## Who is Strux for?

- **Web developers** who need their app to run on dedicated hardware. You don't need embedded Linux experience — Strux builds the OS, and these docs explain the embedded concepts as you meet them.
- **Embedded developers** who want a modern web UI instead of Qt or a framebuffer toolkit. You get a real browser engine with a typed bridge into your Go code, and full control over the kernel, bootloader, and board support underneath.

Typical use cases: kiosks, digital signage, point-of-sale, industrial HMIs, interactive installations, and single-purpose IoT devices with a screen.

## How development feels

1. `strux init` scaffolds a project: frontend, Go backend, configuration, and a QEMU board profile for local testing.
2. `strux dev` starts a live development loop — your app runs in a QEMU virtual machine (or on a real device on your network) with hot reload for both the frontend and the Go backend.
3. `strux build` produces a complete OS image. A smart cache means only the steps affected by your changes are rebuilt.
4. `strux flash` writes the image to real hardware.

Hardware targets are described by **Board Support Packages (BSPs)** — a folder in your project that defines the kernel, bootloader, and device-specific configuration for a board. Your project ships with a QEMU BSP so you can develop on your laptop, and you add BSPs for your real hardware when you're ready. If you need to support a new board, see the [BSP Development guide](/bsp/guide/introduction.html).

## Where to go next

- [Installation](/guide/installation.html) — install the `strux` CLI and its prerequisites.
- [Getting Started](/guide/getting-started.html) — from zero to a booting kiosk in QEMU in about ten minutes.
- [Architecture Overview](/concepts/overview.html) — how the pieces fit together, in more depth.
