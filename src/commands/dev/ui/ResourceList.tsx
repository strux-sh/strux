/***
 *
 *
 * Resource List — Navigable left panel
 *
 *
 */
import React from "react"
import { Box, Text, useInput } from "ink"
import { theme, getStatusIcon, getStatusColor, type ResourceStatus } from "./theme"


export interface Resource {
    name: string
    label: string
    status: ResourceStatus
    detail?: string
    indent?: number
}


interface ResourceListProps {
    resources: Resource[]
    selectedIndex: number
    focused: boolean
    onSelect: (index: number) => void
}


export const ResourceList = React.memo(function ResourceList({ resources, selectedIndex, focused, onSelect }: ResourceListProps) {

    useInput((input, key) => {

        if (!focused) return

        if (key.upArrow || input === "k") {
            onSelect(Math.max(0, selectedIndex - 1))
        }

        if (key.downArrow || input === "j") {
            onSelect(Math.min(resources.length - 1, selectedIndex + 1))
        }

    })


    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={focused ? theme.colors.primary : theme.colors.muted}
            paddingX={1}
            width={28}
            overflow="hidden"
        >

            <Box marginBottom={1}>
                <Text bold color={theme.colors.primary}>Resources</Text>
            </Box>

            {resources.map((resource, i) => {

                const isSelected = i === selectedIndex
                const statusIcon = getStatusIcon(resource.status)
                const statusColor = getStatusColor(resource.status)

                const padding = resource.indent ? "  ".repeat(resource.indent) : ""

                return (
                    <Box key={resource.name} gap={1}>
                        <Text>{padding}</Text>
                        <Text color={isSelected ? theme.colors.primary : theme.colors.muted}>
                            {isSelected ? theme.icons.selected : theme.icons.unselected}
                        </Text>
                        <Text color={statusColor}>{statusIcon}</Text>
                        <Text
                            bold={isSelected}
                            color={isSelected ? theme.colors.text : theme.colors.textDim}
                        >
                            {resource.label}
                        </Text>
                        {resource.detail && (
                            <Text color={theme.colors.muted}>{resource.detail}</Text>
                        )}
                    </Box>
                )

            })}

        </Box>
    )

})
