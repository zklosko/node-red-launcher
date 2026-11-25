import { EventEmitter } from "node:events";
import fs from 'node:fs'

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const MAX_LOG = 2000
const logBuffer: string[] = []
const emitter = new EventEmitter()

let logFile: fs.WriteStream | null = null
let busy: string | null = null

export type LogListener = (line: string) => void
export type BusyListener = (busy: string | null) => void

export interface Logger {
    log: (text: string) => void;
    setBusy: (msg: string | null) => void;
}

export function initLogger(options?: { logFile?: string }) {
    if (options?.logFile) {
        logFile = fs.createWriteStream(options.logFile, {flags: 'a'});
    }
}

export function log(text: string) {
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.replace(ANSI, '').trim()
        if (!line) continue

        logBuffer.push(line)
        if (logBuffer.length > MAX_LOG) logBuffer.shift()
        
        // persist to disk
        // if (logFile) {
        //     const entry = `[${new Date().toISOString()}] ${line}`
        //     logFile.write(entry + '\n')
        // }

        emitter.emit('log', line)
    }
}

export function setBusy(msg: string | null) {
    busy = msg
    emitter.emit('busy', busy)
}

export function getBusy(): string | null {
    return busy
}

export function getLogs(): readonly string[] {
    return [...logBuffer]
}

export function onLog(fn: LogListener) {
    emitter.on('log', fn)
    return () => emitter.off('log', fn)
}

export function onBusy(fn: BusyListener) {
    emitter.on('busy', fn)
    return () => emitter.off('busy', fn)
}

export function clearLogs(): void {
    logBuffer.length = 0
}