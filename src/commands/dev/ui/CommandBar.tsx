/***
 *
 *
 * Command Bar — Bottom keybind hints, context-sensitive
 *
 *
 */
import React from "react"
import { Box, Text } from "ink"
import { theme } from "./theme"


export interface Keybind {
    key: string
    label: string
}


interface CommandBarProps {
    keybinds: Keybind[]
    mode?: string
}


export const CommandBar = React.memo(function CommandBar({ keybinds, mode }: CommandBarProps) {

    return (
        <Box
            borderStyle="round"
            borderColor={theme.colors.muted}
            paddingX={1}
            justifyContent="space-between"
            overflow="hidden"
            height={3}
        >

            <Box gap={2}>
                {keybinds.map((kb) => (
                    <Box key={kb.key} gap={0}>
                        <Text backgroundColor="gray" color="white" bold>{` ${kb.key} `}</Text>
                        <Text color={theme.colors.textDim}> {kb.label}</Text>
                    </Box>
                ))}
            </Box>

            {mode && (
                <Text backgroundColor={theme.colors.accent} color="white" bold>{` ${mode} `}</Text>
            )}

        </Box>
    )

})
