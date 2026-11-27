import { ArrowUpRight } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card'
import type { LabEntry } from '@/lib/labs'

interface Experience {
  title: string
  company: string
  date: string
  location?: string
  bullets: string[]
}

interface Project {
  title: string
  bullets: string[]
  link?: string
}

interface ExperienceProjectsTabsProps {
  experiences: Experience[]
  projects: Project[]
  labs?: LabEntry[]
}

export default function ExperienceProjectsTabs({
  experiences,
  projects,
  labs = [],
}: ExperienceProjectsTabsProps) {
  return (
    <Tabs defaultValue="experience" className="mb-8">
      <TabsList className="mb-4 w-full justify-start rounded-xl p-1">
        <TabsTrigger value="experience" className="text-base font-medium">
          Experience
        </TabsTrigger>
        <TabsTrigger value="projects" className="text-base font-medium">
          Projects
        </TabsTrigger>
        <TabsTrigger value="labs" className="text-base font-medium">
          Labs
        </TabsTrigger>
      </TabsList>
      <TabsContent value="experience">
        {experiences.map((exp, index) => (
          <Card key={index} className="hover-card bg-card/50 mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-xl">{exp.title}</CardTitle>
              <CardDescription className="text-sm">
                {exp.company} | {exp.date}
                {exp.location && ` | ${exp.location}`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-2 pl-5">
                {exp.bullets.map((point, i) => (
                  <li key={i} className="text-muted-foreground">
                    {point}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </TabsContent>
      <TabsContent value="projects">
        {projects.map((project, index) => (
          <Card key={index} className="hover-card bg-card/50 mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-xl">{project.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-2 pl-5">
                {project.bullets.map((point, i) => (
                  <li key={i} className="text-muted-foreground">
                    {point}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </TabsContent>
      <TabsContent value="labs">
        <div className="grid gap-4 sm:grid-cols-2">
          {labs.map((lab) => (
            <a
              key={lab.slug}
              href={lab.href}
              className="group focus-visible:outline-ring block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <Card className="hover-card bg-card/50 flex h-full flex-col justify-between">
                <CardHeader className="pb-3">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <Badge variant="outline" className="text-[0.7rem]">
                      {lab.category}
                    </Badge>
                    <span className="text-muted-foreground group-hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors">
                      Launch
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    </span>
                  </div>
                  <CardTitle className="text-lg">{lab.title}</CardTitle>
                  <CardDescription className="pt-1 text-sm leading-relaxed">
                    {lab.summary}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex flex-wrap gap-1.5">
                    {lab.tags.map((tag) => (
                      <Badge
                        key={tag}
                        variant="secondary"
                        className="text-[0.7rem] font-normal"
                      >
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </a>
          ))}
        </div>
      </TabsContent>
    </Tabs>
  )
}
