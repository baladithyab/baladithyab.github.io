import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card'

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
}

export default function ExperienceProjectsTabs({
  experiences,
  projects,
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
    </Tabs>
  )
}
