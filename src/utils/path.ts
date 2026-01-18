/***
 *
 *  Path Utility Functions
 *
 */

import { statSync, existsSync } from "node:fs"

// Chceks if a File Exists
export function fileExists(path: string): boolean {
    try {
        const stats = statSync(path)
        return stats.isFile()
    } catch {
        return false
    }
}

// Checks if a directory exists
export function directoryExists(path: string): boolean {
    try {
        const stats = statSync(path)
        return stats.isDirectory()
    } catch {
        return false
    }
}

// Checks if a path exists (file or directory)
export function pathExists(path: string): boolean {
    return existsSync(path)
}

/**
 * Validates that a file exists, throws an error if it doesn't
 */
export function validateFileExists(path: string, fieldName: string): void {
    if (!fileExists(path)) {
        throw new Error(`${fieldName} file does not exist: ${path}`)
    }
}

/**
 * Validates that a directory exists, throws an error if it doesn't
 */
export function validateDirectoryExists(path: string, fieldName: string): void {
    if (!directoryExists(path)) {
        throw new Error(`${fieldName} directory does not exist: ${path}`)
    }
}

/**
 * Validates that a path exists (file or directory), throws an error if it doesn't
 */
export function validatePathExists(path: string, fieldName: string): void {
    if (!pathExists(path)) {
        throw new Error(`${fieldName} path does not exist: ${path}`)
    }
}
