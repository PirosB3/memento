"use client";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

export default function AgentTabs({
  configContent,
  rootContent,
  tasksContent,
  taskCount,
}: {
  configContent: React.ReactNode;
  rootContent: React.ReactNode;
  tasksContent: React.ReactNode;
  taskCount: number;
}) {
  return (
    <Tabs defaultValue="tasks">
      <TabsList variant="line" className="w-full justify-start border-b border-border pb-0 mb-6">
        <TabsTrigger value="tasks" className="text-sm">
          Tasks
          <Badge variant="secondary" className="ml-1.5 text-[10px] h-4 px-1.5">{taskCount}</Badge>
        </TabsTrigger>
        <TabsTrigger value="root" className="text-sm">Root Agent</TabsTrigger>
        <TabsTrigger value="config" className="text-sm">Config</TabsTrigger>
      </TabsList>

      <TabsContent value="tasks">{tasksContent}</TabsContent>
      <TabsContent value="root">{rootContent}</TabsContent>
      <TabsContent value="config">{configContent}</TabsContent>
    </Tabs>
  );
}
