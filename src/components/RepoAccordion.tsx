// src/components/RepoAccordion.tsx
import React from 'react'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'

export type Repo = {
  name: string
  html_url: string
  description: string
  updated_at: string
}

type RepoAccordionProps = {
  repos: Repo[]
}

export default function RepoAccordion({ repos }: RepoAccordionProps) {
  return (
    <Accordion type="single" collapsible className="w-full">
      {repos.map((repo, index) => (
        <AccordionItem key={repo.name} value={`item-${index}`}>
          <AccordionTrigger>
            <a
              href={repo.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-blue-500 hover:underline"
            >
              {repo.name}
            </a>
          </AccordionTrigger>
          <AccordionContent>
            <p className="text-sm text-muted-foreground">{repo.description}</p>
            <p className="text-sm text-muted-foreground">
              Last updated: {new Date(repo.updated_at).toLocaleString()}
            </p>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}
