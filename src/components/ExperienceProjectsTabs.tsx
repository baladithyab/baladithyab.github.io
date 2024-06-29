import React from 'react'
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
  description: string
}

interface Project {
  title: string
  description: string
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
      <TabsList className="mb-4">
        <TabsTrigger value="experience">Experience</TabsTrigger>
        <TabsTrigger value="projects">Projects</TabsTrigger>
      </TabsList>
      <TabsContent value="experience">
        {experiences.map((exp, index) => (
          <Card key={index} className="hover-card mb-4">
            <CardHeader>
              <CardTitle>{exp.title}</CardTitle>
              <CardDescription>
                {exp.company} | {exp.date}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p>{exp.description}</p>
            </CardContent>
          </Card>
        ))}
      </TabsContent>
      <TabsContent value="projects">
        {projects.map((project, index) => (
          <Card key={index} className="hover-card mb-4">
            <CardHeader>
              <CardTitle>{project.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p>{project.description}</p>
            </CardContent>
          </Card>
        ))}
      </TabsContent>
    </Tabs>
  )
}
