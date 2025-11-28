import { useState, useEffect } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

interface Experience {
  title: string
  company: string
  date: string
  description: string
}

interface Project {
  title: string
  description: string
  link?: string
}

interface ExperienceProjectsTabsProps {
  experiences: Experience[]
  projects: Project[]
}

// Loading skeleton component
function TabsSkeleton() {
  return (
    <div className="mb-8">
      <div className="mb-4 flex gap-2">
        <Skeleton className="h-10 w-28 rounded-md" />
        <Skeleton className="h-10 w-24 rounded-md" />
      </div>
      <div className="space-y-6">
        {[1, 2, 3].map((i) => (
          <Card key={i} className="bg-card/50">
            <CardHeader className="pb-3">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="mt-2 h-4 w-64" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2 pl-5">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-10/12" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

export default function ExperienceProjectsTabs({
  experiences,
  projects,
}: ExperienceProjectsTabsProps) {
  const [isHydrated, setIsHydrated] = useState(false)

  useEffect(() => {
    setIsHydrated(true)
  }, [])

  // Show skeleton during SSR/hydration
  if (!isHydrated) {
    return <TabsSkeleton />
  }

  // Helper function to create bullet points from text
  const createBulletPoints = (text: string) => {
    // For the AWS experience, manually create better bullet points
    if (text.includes('MLOps proof-of-concept solutions')) {
      return [
        'Developed MLOps proof-of-concept solutions utilizing AWS Sagemaker for scalable machine learning workflows.',
        'Engineered secure multimodal data pipelines supporting near real-time inference for enterprise applications.',
        'Designed and deployed biometric voice authentication systems used by financial institutions and telecommunications.',
        'Created generative AI-driven applications for automating financial reporting and enhancing internal documentation.',
        'Collaborated with Meta on the WebXR Hackathon, achieving recognition at Workday DevCon 2023.',
      ]
    }

    // For the UC Santa Cruz experience
    if (text.includes('Genomics Institute')) {
      return [
        'Architected scalable cloud infrastructure, enhancing computational capabilities for genomic research.',
        'Managed migration and optimization of datasets from Google BigQuery to AWS Elasticsearch.',
        'Significantly improved data accessibility and research capabilities.',
      ]
    }

    // For the Johns Hopkins experience
    if (text.includes('Brain-Computer Interfaces')) {
      return [
        'Developed SDK modules and user interfaces for metrics querying and simulation environments targeting BCIs.',
        'Improved user experience by enhancing software interaction capabilities within neuroscience simulation frameworks.',
        'Obtained civilian security clearance to support sensitive research projects.',
      ]
    }

    // For specific projects
    if (text.includes('Second Brain Personal Assistant')) {
      return [
        'Built a containerized, self-hosted server infrastructure for capturing, retrieving, and storing knowledge in real-time.',
        'Integrated GPT-4o to augment and dynamically organize data from web browsing sessions and received content.',
        'Developed a responsive UI for seamless interaction with your knowledge base.',
      ]
    }

    if (text.includes('Video Hosting & AV1')) {
      return [
        'Constructed an automated AWS-based pipeline for efficient video ingestion and transcoding to AV1 format.',
        'Implemented a robust content delivery system for optimized video streaming.',
        'Created an intuitive web interface with adaptive bitrate streaming capabilities.',
      ]
    }

    if (text.includes('Algorithmic Trading')) {
      return [
        'Designed a scalable system for evaluating and optimizing stock trading algorithms.',
        'Leveraged LLMs to write financial models for backtesting.',
        'Implemented genetic algorithm approaches to identify optimal trading strategies.',
      ]
    }

    if (text.includes('Audio Capture')) {
      return [
        'Developed a platform-independent audio capturing solution for real-time transcription.',
        'Integrated machine learning pipelines for live speaker diarization.',
        'Created accurate transcription capabilities across various conferencing applications.',
      ]
    }

    // Fallback for any other text
    return text
      .split('.')
      .filter((point) => point.trim().length > 0)
      .map((point) => point.trim() + '.')
  }

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
          <Card key={index} className="hover-card mb-6 bg-card/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-xl">{exp.title}</CardTitle>
              <CardDescription className="text-sm">
                {exp.company} | {exp.date}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-2 pl-5">
                {createBulletPoints(exp.description).map((point, i) => (
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
          <Card key={index} className="hover-card mb-6 bg-card/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-xl">{project.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-2 pl-5">
                {createBulletPoints(project.description).map((point, i) => (
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
