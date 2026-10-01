# Markdown Formatting Guide for Documentation System

This guide provides best practices and formatting guidelines for creating markdown documents that render beautifully in the PPT Agentic documentation system.

---

## 📋 Quick Reference

**Renderer**: Markdoc with Prism syntax highlighting and Mermaid diagrams
**Output**: Static HTML with PrescriberPoint branding
**Location**: Place `.md` files in `/docs` directory (recursively)
**Build**: Run `./render-docs.sh` to generate HTML in `/docs-dist`

---

## 🎯 Document Structure

### Heading Hierarchy

Use proper heading hierarchy for navigation and styling:

```markdown
# Page Title (H1)
Main page title - renders with large font, appears in browser tab

## Major Section (H2)
Orange accent bar appears on left side

### Subsection (H3)
Standard section heading

#### Component Title (H4)
Teal-colored heading for technical components
```

**Best Practices**:
- ✅ One H1 per document (extracted as page title)
- ✅ Don't skip heading levels (H1 → H2 → H3)
- ✅ Use H4 for technical component names
- ✅ Keep headings concise and descriptive

---

## 💻 Code Blocks

### Syntax Highlighting

Specify language for proper Monokai syntax highlighting:

\`\`\`csharp
public interface IAgentOrchestrator
{
    Task<AgentResult> ProcessAsync(AgentRequest request);
}
\`\`\`

**Supported Languages**:
- `bash` / `shell` - Shell scripts
- `csharp` - C# code
- `typescript` / `javascript` - TypeScript/JS
- `json` - JSON data
- `yaml` - YAML configuration
- `docker` - Dockerfiles
- `sql` - SQL queries
- `text` - Plain text (no highlighting)

### Inline Code

Use backticks for inline code references:

```markdown
The `IAgentOrchestrator` service manages runtime lifecycle.
Use the `--namespace` flag to specify the namespace.
Configuration is stored in `appsettings.json`.
```

**Renders as**: Orange-colored inline code with subtle background

---

## 📊 Mermaid Diagrams

### Creating Diagrams

Use \`\`\`mermaid code blocks for diagrams:

\`\`\`mermaid
graph TB
    A[Client] --> B[Gateway]
    B --> C[Orchestrator]
    C --> D[Kubernetes]

    style A fill:#E8F4F3,stroke:#1E6B62
    style C fill:#FFD8A9,stroke:#C4420A
\`\`\`

### Supported Diagram Types

**Flowcharts**:
\`\`\`mermaid
graph TB
    Start[Start] --> Process[Process]
    Process --> End[End]
\`\`\`

**Sequence Diagrams**:
\`\`\`mermaid
sequenceDiagram
    Client->>Gateway: Request
    Gateway->>Orchestrator: Process
    Orchestrator-->>Gateway: Response
    Gateway-->>Client: Result
\`\`\`

**State Diagrams**:
\`\`\`mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Running
    Running --> Completed
    Running --> Failed
    Completed --> [*]
    Failed --> [*]
\`\`\`

### Color Scheme (60-30-10 Rule)

**Infrastructure (30% - Teal)**:
```markdown
style NodeName fill:#E8F4F3,stroke:#1E6B62
```

**Critical Components (10% - Orange)**:
```markdown
style NodeName fill:#FFD8A9,stroke:#C4420A
```

**Semantic Colors**:
```markdown
style Success fill:#C8E6C5,stroke:#1E6128
style Error fill:#FFCDD2,stroke:#8B0B15
style Warning fill:#FFE0B2,stroke:#B85D23
```

**Best Practices**:
- ✅ Use teal for infrastructure/stable components
- ✅ Use orange for critical/orchestration components
- ✅ Add descriptive labels with `<br/>` for line breaks
- ✅ Keep diagrams focused (5-10 nodes maximum)
- ✅ Use subgraphs for logical grouping

---

## 📝 Text Formatting

### Emphasis

```markdown
**Bold text** - Strong emphasis
*Italic text* - Subtle emphasis
***Bold italic*** - Maximum emphasis
`code` - Inline code reference
```

### Lists

**Unordered Lists**:
```markdown
- First item
- Second item
  - Nested item
  - Another nested item
- Third item
```

**Ordered Lists**:
```markdown
1. First step
2. Second step
3. Third step
```

**Task Lists** (renders with checkmarks):
```markdown
- ✅ Completed task
- 📋 Pending task
- 🔶 In progress task
```

---

## 📊 Tables

### Basic Tables

```markdown
| Component | Status | Notes |
|-----------|--------|-------|
| **Orchestrator** | ✅ Implemented | Core service |
| **Job Manager** | ✅ Implemented | K8s integration |
| **Health Monitor** | ✅ Implemented | Real-time monitoring |
```

**Styling**:
- Headers: White text on teal background (#2A8D81)
- Rows: Hover effect with light background
- Use `**bold**` for important cells
- Use emoji for status indicators (✅, 📋, 🔶)

### Alignment

```markdown
| Left | Center | Right |
|:-----|:------:|------:|
| Text | Text | Text |
```

---

## 🔗 Links

### Internal Links

Link to other documentation pages:

```markdown
See [Authorization Guide](AUTHORIZATION.md) for details.
Refer to [Docker Setup](development/DOCKER.md) for containerization.
```

**Note**: Links will be automatically converted to `.html` in rendered output.

### External Links

```markdown
[Kubernetes Documentation](https://kubernetes.io/docs/)
[Azure Best Practices](https://learn.microsoft.com/azure/)
```

### Section Links

Link to headings within the same document:

```markdown
See [Architecture Overview](#architecture-overview) below.
```

---

## 📋 Metadata

### Document Header

Start documents with metadata for context:

```markdown
# Document Title

**Project**: Project Name
**Version**: 1.0
**Last Updated**: 2025-10-14
**Author**: Team/Role Name

---

## Overview

Content starts here...
```

**Footer Metadata** (separate lines with `<em>`):

```markdown
---

*Version: 1.0*
*Last Updated: 2025-10-14*
*Review Cycle: Quarterly*
```

---

## 🎨 Visual Elements

### Horizontal Rules

Use `---` for section breaks (renders as styled divider):

```markdown
---
```

### Blockquotes

```markdown
> **Note**: This is an important callout.
> Use blockquotes for warnings, tips, or important context.
```

**Renders with**: Orange left accent bar, light background

### Callout Patterns

```markdown
**⚠️ Warning**: Critical security consideration

**💡 Tip**: Performance optimization suggestion

**✅ Best Practice**: Recommended approach

**🔒 Security**: HIPAA compliance requirement
```

---

## 📁 File Organization

### Directory Structure

Organize documentation by topic:

```
docs/
├── README.md                    # Index/landing page
├── development/                 # Development guides
│   ├── README.md
│   ├── DOCKER.md
│   └── DEVELOPMENT.md
├── deployment/                  # Deployment docs
│   └── CI-CD.md
├── api/                         # API documentation
│   ├── README.md
│   └── authentication.md
├── operations/                  # Operational runbooks
│   ├── RUNBOOK_INDEX.md
│   └── INCIDENT_RESPONSE_RUNBOOK.md
└── adr/                         # Architecture Decision Records
    ├── README.md
    └── ADR-001-decision-name.md
```

**Best Practices**:
- ✅ Use descriptive filenames (UPPER_SNAKE_CASE or kebab-case)
- ✅ Include README.md in each directory
- ✅ Group related documents in subdirectories
- ✅ Keep file names under 50 characters

---

## 🔤 Naming Conventions

### File Names

```markdown
✅ GOOD:
- K8S_ORCHESTRATION_ARCHITECTURE.md
- EPA_Implementation_Plan.md
- ADR-001-kubernetes-orchestration.md

❌ AVOID:
- doc1.md (non-descriptive)
- my document.md (spaces)
- VeryLongFileNameThatGoesOnForeverAndEver.md (too long)
```

### Heading Titles

```markdown
✅ GOOD:
## System Architecture Overview
### Agent Runtime Configuration
#### KubernetesJobManager Service

❌ AVOID:
## SYSTEM ARCHITECTURE (all caps)
### agent runtime config (inconsistent case)
#### service (too vague)
```

---

## 📐 Formatting Best Practices

### Line Length

- Keep lines under 100 characters for readability
- Break long paragraphs into multiple shorter ones
- Use lists for enumeration instead of long sentences

### Spacing

```markdown
## Section Title

Paragraph text with proper spacing.

Another paragraph after a blank line.

### Subsection

- List item
- Another item

More content here.
```

**Rules**:
- ✅ Blank line before and after headings
- ✅ Blank line before and after code blocks
- ✅ Blank line before and after lists
- ✅ Blank line between paragraphs

### Code Block Spacing

```markdown
Configuration example:

\`\`\`json
{
  "setting": "value"
}
\`\`\`

Explanation of the configuration above.
```

---

## 🎯 Special Features

### Technical Specifications

For technical specs, use consistent formatting:

```markdown
**Component**: `KubernetesJobManager`
**Purpose**: Kubernetes Job lifecycle management
**Technology**: .NET 9, KubernetesClient

**Responsibilities**:
- Create and delete Kubernetes Jobs
- Monitor job status
- Handle cleanup with TTL
- Query jobs by labels

**Key Methods**:
\`\`\`csharp
Task<V1Job> CreateJobAsync(JobSpec jobSpec);
Task DeleteJobAsync(string jobName, string namespace);
Task<V1Job?> GetJobAsync(string jobName, string namespace);
\`\`\`
```

### Decision Records (ADRs)

For Architecture Decision Records:

```markdown
# ADR-001: Decision Title

**Status**: Accepted | Proposed | Deprecated
**Date**: 2025-10-14
**Deciders**: Team names

## Context

Problem statement and background...

## Decision

What was decided and why...

## Consequences

### Positive
- Benefit 1
- Benefit 2

### Negative
- Trade-off 1
- Trade-off 2

## Alternatives Considered

### Option 1
- Description
- Rejected because...
```

---

## 🚫 What to Avoid

### Don't Use

❌ **HTML tags** - Use Markdown syntax instead
```markdown
❌ <div style="color: red;">Text</div>
✅ **Important Text**
```

❌ **Complex nesting** - Keep structure simple
```markdown
❌ Deep nested lists (5+ levels)
✅ Maximum 3 levels of nesting
```

❌ **Very large tables** - Break into sections
```markdown
❌ Tables with 20+ columns
✅ Multiple focused tables
```

❌ **Gigantic diagrams** - Split into logical pieces
```markdown
❌ 30+ node diagrams
✅ 5-10 node focused diagrams
```

❌ **Inline styles in markdown** - Use semantic markdown
```markdown
❌ <span style="color: blue;">Text</span>
✅ **Text** or *Text* or `code`
```

---

## ✅ Rendering Checklist

Before adding a new document:

- [ ] Heading hierarchy is logical (H1 → H2 → H3)
- [ ] Code blocks have language specified
- [ ] Mermaid diagrams use PPT color scheme
- [ ] Tables are well-formatted with proper headers
- [ ] Links use relative paths
- [ ] File name is descriptive and follows convention
- [ ] Blank lines separate sections properly
- [ ] No lines exceed 100 characters
- [ ] Metadata included at top and bottom
- [ ] Document renders correctly (`./render-docs.sh`)

---

## 🎨 PrescriberPoint Branding

### Colors in Diagrams

**60% - Neutral Backgrounds**:
```markdown
style Node fill:#FFFFFF,stroke:#D8D1C9
```

**30% - Infrastructure (Teal)**:
```markdown
style Infrastructure fill:#E8F4F3,stroke:#1E6B62
style Kubernetes fill:#C8E6E3,stroke:#2A8D81
```

**10% - Critical/Accent (Orange)**:
```markdown
style Orchestrator fill:#FFD8A9,stroke:#C4420A
style Gateway fill:#FEBB73,stroke:#F35C0A
```

### Typography

- **Font**: Mulish (automatically applied)
- **Code**: Monokai theme (dark background, colorful syntax)
- **Headings**: Hierarchical sizing with proper weight
- **Body**: Readable line-height (1.6)

---

## 📖 Examples

### Well-Formatted Document

```markdown
# Kubernetes Orchestration Architecture

**Project**: K8S-ORCH
**Version**: 1.0
**Last Updated**: 2025-10-14

---

## Overview

The Kubernetes orchestration layer provides dynamic agent runtime management with enterprise-grade observability.

### Key Features

- **Dynamic Scaling**: Auto-scales based on demand
- **HIPAA Compliance**: Built-in security controls
- **Multi-Region**: Active-passive DR strategy

---

## Architecture Diagram

\`\`\`mermaid
graph TB
    Client[Client Apps] --> Gateway[API Gateway]
    Gateway --> Orch[Orchestrator]
    Orch --> K8s[Kubernetes]

    style Orch fill:#FFD8A9,stroke:#C4420A
    style K8s fill:#C8E6E3,stroke:#1E6B62
\`\`\`

---

## Component Details

### Agent Runtime Orchestrator

**Interface**: `IAgentRuntimeOrchestrator`

**Purpose**: High-level orchestration of AI agent runtime lifecycle

**Key Methods**:
\`\`\`csharp
Task<AgentResult> StartAgentAsync(AgentRequest request);
Task<AgentStatus> GetStatusAsync(string runtimeId);
Task StopAgentAsync(string runtimeId);
\`\`\`

---

## Configuration

Example configuration:

\`\`\`json
{
  "orchestration": {
    "namespace": "ppt-agentic",
    "maxConcurrentAgents": 1000,
    "defaultTimeout": "5m"
  }
}
\`\`\`

---

*Version: 1.0*
*Last Updated: 2025-10-14*
```

---

## 🔧 Technical Tips

### Escaping Characters

When showing Mermaid syntax in code blocks:

\`\`\`markdown
To show Mermaid code without rendering:
\\\`\\\`\\\`mermaid
graph TB
    A --> B
\\\`\\\`\\\`
\`\`\`

### Line Breaks

Use blank lines for paragraph breaks:

```markdown
First paragraph.

Second paragraph after blank line.
```

For metadata footer, use `<em>` tags for each line:

```markdown
<em>Version: 1.0</em>
<em>Last Updated: 2025-10-14</em>
<em>Author: Team Name</em>
```

### Long URLs

Break long URLs with markdown link syntax:

```markdown
❌ https://very-long-url.com/path/to/resource?param1=value&param2=value

✅ [Resource Documentation](https://very-long-url.com/path/to/resource?param1=value&param2=value)
```

---

## 📂 Navigation Optimization

### File Naming for Navigation

Files appear in navigation sidebar sorted alphabetically within folders.

**Strategic Naming**:
```markdown
README.md                  # Always first in folder
01-SETUP.md               # Number prefix for ordering
02-CONFIGURATION.md
03-DEPLOYMENT.md
```

### Folder Structure

Folders appear before files in navigation:

```
📁 development/           # Folder (uppercase label)
  📄 README
  📄 DOCKER
📁 deployment/
  📄 CI-CD
📄 AUTHORIZATION          # Root-level files after folders
📄 README
```

---

## 🎯 Content Guidelines

### Write for Your Audience

**Technical Docs** (development/, api/):
- Include code examples
- Provide configuration samples
- Technical detail is good

**Operational Docs** (operations/):
- Step-by-step procedures
- Clear decision trees
- Incident response flows

**Architecture Docs** (adr/, root):
- High-level diagrams
- Design rationale
- Trade-off analysis

### Use Active Voice

```markdown
✅ "The orchestrator creates Kubernetes Jobs"
❌ "Kubernetes Jobs are created by the orchestrator"
```

### Be Concise

```markdown
✅ "Scales based on CPU usage"
❌ "The system will automatically scale the number of pods based on the current CPU usage metrics"
```

---

## 🚀 Advanced Features

### Nested Code in Lists

```markdown
1. **Install Dependencies**:
   \`\`\`bash
   dotnet add package KubernetesClient
   \`\`\`

2. **Configure Services**:
   \`\`\`csharp
   services.AddKubernetesClient();
   \`\`\`
```

### Complex Tables

For tables with code:

```markdown
| Method | Example | Description |
|--------|---------|-------------|
| GET | `GET /api/agents/{id}` | Retrieve agent |
| POST | `POST /api/agents` | Create agent |
```

### Combining Diagrams and Tables

```markdown
## System Flow

\`\`\`mermaid
sequenceDiagram
    Client->>API: Request
    API->>Service: Process
\`\`\`

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/agents` | POST | Create agent runtime |
```

---

## 📊 Quality Standards

### Documentation Quality Checklist

**Clarity**:
- [ ] Purpose stated in first paragraph
- [ ] Technical terms defined
- [ ] Examples provided for complex concepts

**Completeness**:
- [ ] All public APIs documented
- [ ] Configuration options explained
- [ ] Error handling described

**Accuracy**:
- [ ] Code examples tested
- [ ] Links verified
- [ ] Version numbers current

**Consistency**:
- [ ] Heading hierarchy logical
- [ ] Terminology consistent
- [ ] Formatting matches this guide

---

## 🛠️ Troubleshooting

### Common Issues

**Mermaid diagram not rendering**:
- Check for syntax errors in diagram code
- Ensure \`\`\`mermaid code block is properly closed
- Verify diagram type is supported

**Code highlighting incorrect**:
- Specify correct language (`csharp` not `cs`)
- Check for unclosed code blocks
- Verify language is supported (see list above)

**Links broken**:
- Use relative paths from current file
- Don't use `.html` extension (use `.md`)
- Check file exists in docs/ directory

**Table formatting issues**:
- Ensure pipes `|` align
- Include header separator row
- Check for unclosed table cells

---

## 🎓 Learning Resources

### Markdown Basics
- [CommonMark Spec](https://commonmark.org/)
- [Markdown Guide](https://www.markdownguide.org/)

### Mermaid Diagrams
- [Mermaid Documentation](https://mermaid.js.org/)
- [Mermaid Live Editor](https://mermaid.live/)

### Color Theory
- See `scripts/docs-renderer/COLOR_THEORY.md`
- PrescriberPoint Design System (admin-tool)

---

## 📝 Quick Start Template

Copy this template for new documents:

\`\`\`markdown
# Document Title

**Project**: Project Name
**Version**: 1.0
**Last Updated**: YYYY-MM-DD
**Author**: Your Name/Team

---

## Overview

Brief description of what this document covers.

## Section 1

Content here...

### Subsection

More detailed content...

\`\`\`language
code example
\`\`\`

## Section 2

More content...

---

*Version: 1.0*
*Last Updated: YYYY-MM-DD*
*Author: Team Name*
\`\`\`

---

## 🔄 Workflow

### Creating New Documentation

1. **Create File**: Place `.md` file in `/docs` or subdirectory
2. **Write Content**: Follow this guide's formatting
3. **Add Diagrams**: Use Mermaid with PPT colors
4. **Test Render**: Run `./render-docs.sh`
5. **Verify Output**: Check `/docs-dist/` in browser
6. **Iterate**: Fix any rendering issues

### Updating Documentation

1. Edit `.md` file in `/docs`
2. Re-run `./render-docs.sh`
3. Hard refresh browser (Cmd+Shift+R)
4. Verify changes rendered correctly

---

## 🎉 Summary

**Key Principles**:
1. **Use proper heading hierarchy** (H1 → H2 → H3 → H4)
2. **Specify code block languages** for syntax highlighting
3. **Apply PPT color scheme** to Mermaid diagrams
4. **Keep it simple** - Clean, readable markdown
5. **Test rendering** - Always run `./render-docs.sh`

**The Result**: Beautiful, professional documentation with:
- PrescriberPoint branding
- Professional Monokai code highlighting
- High-contrast Mermaid diagrams
- Responsive, navigable interface
- Fast static HTML output

---

*Markdown Guide Version: 1.0*
*Created: 2025-10-14*
*For: PPT Agentic Documentation System*
*Renderer: Markdoc + Prism + Mermaid*
