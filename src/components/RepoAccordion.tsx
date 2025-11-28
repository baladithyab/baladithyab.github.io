import { useState, useEffect } from 'react'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Skeleton } from '@/components/ui/skeleton'

export type Repo = {
  name: string
  html_url: string
  description: string
  updated_at: string
}

type RepoAccordionProps = {
  repos: Repo[]
}

function RepoAccordionSkeleton() {
  return (
    <div className="w-full space-y-2">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="rounded-md border px-4 py-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-4" />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function RepoAccordion({ repos }: RepoAccordionProps) {
  const [isHydrated, setIsHydrated] = useState(false)

  useEffect(() => {
    setIsHydrated(true)
  }, [])

  if (!isHydrated) {
    return <RepoAccordionSkeleton />
  }

  if (!repos || repos.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No repositories to display.
      </p>
    )
  }

  return (
    <Accordion type="single" collapsible className="w-full">
      {repos.map((repo, index) => (
        <AccordionItem key={repo.name} value={`item-${index}`}>
          <AccordionTrigger>
            <a
              href={repo.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {repo.name}
            </a>
          </AccordionTrigger>
          <AccordionContent>
            <p className="text-sm text-muted-foreground">
              {repo.description || 'No description available'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Last updated: {new Date(repo.updated_at).toLocaleDateString()}
            </p>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}
