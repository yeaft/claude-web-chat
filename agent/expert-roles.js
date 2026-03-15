/**
 * 帮帮团 (Expert Panel) — Agent-side message templates
 *
 * Defines EXPERT_ROLES with messagePrefix, messageTemplate, defaultMessage
 * for each role × action combination (26 roles × ~3 actions = ~78 entries).
 *
 * Role IDs and Action IDs MUST align with web/utils/expert-roles.js (frontend).
 */

const EXPERT_ROLES = {
  // ============================================================
  // 🖥️ 软件开发团队 (12 roles)
  // ============================================================
  jobs: {
    name: 'Jobs',
    messagePrefix: '请以 Steve Jobs（产品经理）的产品思维回答：\n\n',
    messagePrefixEn: 'Please answer from Steve Jobs\'s (Product Manager) product thinking perspective:\n\n',
    actions: {
      'product-analysis': {
        name: '产品分析', nameEn: 'Product Analysis',
        messageTemplate: '请以 Steve Jobs（产品经理）的产品思维分析。聚焦用户痛点、体验流畅性、是否存在多余步骤。\n\n',
        messageTemplateEn: 'Please analyze from Steve Jobs\'s (Product Manager) perspective. Focus on user pain points, experience fluency, unnecessary steps.\n\n',
        defaultMessage: '请以 Steve Jobs（产品经理）的产品思维，分析当前对话中讨论的产品/功能方案。\n聚焦：解决的痛点是否真实？用户旅程是否流畅？有没有多余的步骤？\n给出：保留什么、砍掉什么、改进什么。抓住一个最关键的问题深入。',
        defaultMessageEn: 'Please analyze the product/feature discussed in the current conversation from Steve Jobs\'s product thinking perspective.\nFocus: Is the pain point real? Is the user journey smooth? Are there unnecessary steps?\nOutput: What to keep, cut, and improve. Deep-dive into the single most critical issue.'
      },
      'design-review': {
        name: '设计审查', nameEn: 'Design Review',
        messageTemplate: '请以 Steve Jobs（产品经理）的设计标准审查。聚焦用户第一印象、操作直觉性、认知负担、视觉层次。\n\n',
        messageTemplateEn: 'Please review from Steve Jobs\'s (Product Manager) design standards. Focus on first impression, intuitive operations, cognitive load, visual hierarchy.\n\n',
        defaultMessage: '请以 Steve Jobs（产品经理）的设计标准，审查当前对话中的 UI/交互设计方案。\n聚焦：用户第一眼看到什么？操作路径是否符合直觉？有没有认知负担？视觉层次是否清晰？\n原则：少即是多。如果一个功能需要说明书，它就失败了。',
        defaultMessageEn: 'Please review the UI/interaction design in the current conversation from Steve Jobs\'s design standards.\nFocus: What does the user see first? Is the operation path intuitive? Is there cognitive overload? Is visual hierarchy clear?\nPrinciple: Less is more. If a feature needs a manual, it has failed.'
      },
      'requirements': {
        name: '需求拆解', nameEn: 'Requirements',
        messageTemplate: '请以 Steve Jobs（产品经理）的需求洞察力拆解。聚焦用户真正想要什么、最小可行方案、优先级排序。\n\n',
        messageTemplateEn: 'Please break down requirements from Steve Jobs\'s (Product Manager) insight. Focus on what users truly want, MVP, priority ranking.\n\n',
        defaultMessage: '请以 Steve Jobs（产品经理）的需求洞察力，拆解当前对话中讨论的需求。\n聚焦：用户真正想要什么（不是他说的）？最小可行方案是什么？哪些是 P0 哪些是噪音？\n输出：清晰的需求列表，按优先级排序，每条不超过一句话。',
        defaultMessageEn: 'Please break down the requirements discussed in the current conversation from Steve Jobs\'s insight.\nFocus: What do users truly want (not what they say)? What is the MVP? Which are P0 vs noise?\nOutput: Clear prioritized requirement list, one sentence each.'
      }
    }
  },
  fowler: {
    name: 'Fowler',
    messagePrefix: '请以 Martin Fowler（软件架构师）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Martin Fowler\'s (Software Architect) perspective:\n\n',
    actions: {
      'architecture': {
        name: '架构审查', nameEn: 'Architecture Review',
        messageTemplate: '请以 Martin Fowler（软件架构师）的视角审查架构。关注模块边界、依赖方向、职责划分、是否过度设计。\n\n',
        messageTemplateEn: 'Please review architecture from Martin Fowler\'s (Software Architect) perspective. Focus on module boundaries, dependency direction, responsibility separation, over-engineering.\n\n',
        defaultMessage: '请以 Martin Fowler（软件架构师）的视角，审查当前对话中讨论的架构方案。\n关注：模块边界是否清晰？依赖方向是否正确？职责是否单一？有没有过度设计？\n权衡 YAGNI 和合理预留。给出架构级建议，不纠结代码细节。',
        defaultMessageEn: 'Please review the architecture discussed in the current conversation from Martin Fowler\'s perspective.\nFocus: Are module boundaries clear? Is dependency direction correct? Is responsibility single? Any over-engineering?\nBalance YAGNI with reasonable extensibility. Give architecture-level advice, not code details.'
      },
      'refactoring': {
        name: '重构分析', nameEn: 'Refactoring',
        messageTemplate: '请以 Martin Fowler（重构专家）的视角分析。关注过长函数、特性嫉妒、散弹式修改、重复代码、过度耦合。\n\n',
        messageTemplateEn: 'Please analyze from Martin Fowler\'s (refactoring expert) perspective. Focus on long methods, feature envy, shotgun surgery, code duplication, excessive coupling.\n\n',
        defaultMessage: '请以 Martin Fowler（重构专家）的视角，对当前代码进行重构分析。\n关注：过长函数、特性嫉妒、散弹式修改、重复代码、过度耦合。\n识别代码坏味道，给出具体的重构手法和步骤。',
        defaultMessageEn: 'Please analyze the current code for refactoring from Martin Fowler\'s perspective.\nFocus: Long methods, feature envy, shotgun surgery, code duplication, excessive coupling.\nIdentify code smells and provide specific refactoring techniques and steps.'
      },
      'code-review': {
        name: '代码审查', nameEn: 'Code Review',
        messageTemplate: '请以 Martin Fowler（软件架构师）的代码审查标准分析。关注设计意图、命名精确性、单一职责、错误处理。\n\n',
        messageTemplateEn: 'Please review code from Martin Fowler\'s (Software Architect) standards. Focus on design intent, naming precision, single responsibility, error handling.\n\n',
        defaultMessage: '请以 Martin Fowler（软件架构师）的代码审查标准，审查当前对话中最近的代码变更。\n关注：变更是否符合设计意图？命名是否精确？函数是否单一职责？错误处理是否完整？边界条件是否覆盖？\n发现问题直接指出位置和修改建议。通过就说 LGTM。',
        defaultMessageEn: 'Please review the latest code changes in the current conversation from Martin Fowler\'s code review standards.\nFocus: Does the change match design intent? Is naming precise? Are functions single-responsibility? Is error handling complete? Are edge cases covered?\nPoint out issues with location and fix suggestions. Say LGTM if it passes.'
      }
    }
  },
  torvalds: {
    name: 'Torvalds',
    messagePrefix: '请以 Linus Torvalds（系统开发工程师）的严苛标准回答：\n\n',
    messagePrefixEn: 'Please answer from Linus Torvalds\'s (Systems Engineer) rigorous standards:\n\n',
    actions: {
      'system-design': {
        name: '系统设计', nameEn: 'System Design',
        messageTemplate: '请以 Linus Torvalds（系统工程师）的标准审查系统设计。关注数据结构选择、并发安全、错误传播、资源生命周期。\n\n',
        messageTemplateEn: 'Please review system design from Linus Torvalds\'s (Systems Engineer) standards. Focus on data structure choice, concurrency safety, error propagation, resource lifecycle.\n\n',
        defaultMessage: '请以 Linus Torvalds（系统工程师）的标准，审查当前对话中的系统设计方案。\n关注：数据结构选择是否正确？并发模型是否安全？错误传播路径是否清晰？资源生命周期是否可控？\n直接说哪里有问题，为什么有问题，怎么改。',
        defaultMessageEn: 'Please review the system design in the current conversation from Linus Torvalds\'s standards.\nFocus: Is the data structure choice correct? Is the concurrency model safe? Is error propagation clear? Is resource lifecycle controlled?\nDirectly state what\'s wrong, why, and how to fix it.'
      },
      'performance': {
        name: '性能优化', nameEn: 'Performance',
        messageTemplate: '请以 Linus Torvalds（系统工程师）的性能标准审查。关注热路径、内存分配、不必要拷贝、I/O 批量化、锁粒度。\n\n',
        messageTemplateEn: 'Please review performance from Linus Torvalds\'s (Systems Engineer) standards. Focus on hot paths, memory allocation, unnecessary copies, I/O batching, lock granularity.\n\n',
        defaultMessage: '请以 Linus Torvalds（系统工程师）的性能标准，审查当前对话中代码的性能问题。\n关注：热路径是否最短？内存分配是否可避免？有没有不必要的拷贝？I/O 是否可以批量化？锁粒度是否合理？\n不要给理论建议，给可以直接改的具体方案。',
        defaultMessageEn: 'Please review performance issues in the current conversation\'s code from Linus Torvalds\'s standards.\nFocus: Is the hot path shortest? Can memory allocation be avoided? Any unnecessary copies? Can I/O be batched? Is lock granularity appropriate?\nGive concrete actionable solutions, not theoretical advice.'
      },
      'code-style': {
        name: '代码风格', nameEn: 'Code Style',
        messageTemplate: '请以 Linus Torvalds（系统工程师）的代码风格标准审查。关注可读性、变量命名、函数长度、嵌套深度。\n\n',
        messageTemplateEn: 'Please review code style from Linus Torvalds\'s (Systems Engineer) standards. Focus on readability, variable naming, function length, nesting depth.\n\n',
        defaultMessage: '请以 Linus Torvalds（系统工程师）的代码风格标准，审查当前对话中的代码。\n标准：代码要让人一眼看懂意图。变量名要说人话。函数不超过一屏。嵌套不超过三层。\n注释只在非显而易见的地方。直接说烂在哪里。',
        defaultMessageEn: 'Please review the code in the current conversation from Linus Torvalds\'s code style standards.\nStandards: Code should convey intent at a glance. Variable names should be human-readable. Functions fit one screen. Nesting no more than 3 levels.\nComments only where non-obvious. Directly state what\'s bad.'
      },
      'implementation': {
        name: '代码实现', nameEn: 'Implementation',
        messageTemplate: '请以 Linus Torvalds（系统工程师）的实现标准编写代码。追求简洁高效、边界清晰、错误路径完整。\n\n',
        messageTemplateEn: 'Please implement code from Linus Torvalds\'s (Systems Engineer) standards. Pursue simplicity, clear boundaries, complete error paths.\n\n',
        defaultMessage: '请以 Linus Torvalds（系统工程师）的标准，实现当前对话中讨论的功能。\n原则：用最简单的方式解决问题。每个函数做且只做一件事。错误路径和正常路径同样重要。\n先写数据结构，再写逻辑。代码即文档。',
        defaultMessageEn: 'Please implement the feature discussed in the current conversation from Linus Torvalds\'s standards.\nPrinciples: Solve problems the simplest way. Each function does one thing. Error paths are as important as happy paths.\nData structures first, then logic. Code is documentation.'
      }
    }
  },
  beck: {
    name: 'Beck',
    messagePrefix: '请以 Kent Beck（测试工程师 / TDD 创始人）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Kent Beck\'s (Test Engineer / TDD creator) perspective:\n\n',
    actions: {
      'test-strategy': {
        name: '测试策略', nameEn: 'Test Strategy',
        messageTemplate: '请以 Kent Beck（测试工程师）的测试思维设计测试策略。只测业务逻辑，不测实现细节。\n\n',
        messageTemplateEn: 'Please design test strategy from Kent Beck\'s (Test Engineer) thinking. Test business logic only, not implementation details.\n\n',
        defaultMessage: '请以 Kent Beck（测试工程师）的测试思维，为当前对话中的代码设计测试策略。\n原则：只测业务逻辑（条件分支、状态转换、计算逻辑、错误处理），不测实现细节（CSS 值、HTML 结构、文字内容）。\n输出：关键测试用例列表，每个用例一句话描述输入→预期输出。10-25 个用例足够。',
        defaultMessageEn: 'Please design a test strategy for the code in the current conversation from Kent Beck\'s testing perspective.\nPrinciple: Test business logic only (conditionals, state transitions, calculations, error handling), not implementation details (CSS values, HTML structure, text content).\nOutput: Key test case list, one sentence per case describing input → expected output. 10-25 cases is sufficient.'
      },
      'tdd-guide': {
        name: 'TDD 指导', nameEn: 'TDD Guide',
        messageTemplate: '请以 Kent Beck（测试工程师）的 TDD 方法论指导。流程：Red → Green → Refactor。\n\n',
        messageTemplateEn: 'Please guide with Kent Beck\'s (Test Engineer) TDD methodology. Flow: Red → Green → Refactor.\n\n',
        defaultMessage: '请以 Kent Beck（测试工程师）的 TDD 方法论，指导如何实现当前对话中讨论的功能。\n流程：Red（写失败测试）→ Green（最小实现）→ Refactor（重构到优雅）。\n给出前 3 个测试用例的顺序建议——从最简单的 happy path 开始，逐步增加复杂度。',
        defaultMessageEn: 'Please guide the implementation of the feature discussed using Kent Beck\'s TDD methodology.\nFlow: Red (write failing test) → Green (minimal implementation) → Refactor (refactor to elegance).\nSuggest the order of the first 3 test cases — start with the simplest happy path, gradually increase complexity.'
      },
      'quality-check': {
        name: '质量评估', nameEn: 'Quality Check',
        messageTemplate: '请以 Kent Beck（测试工程师）的标准评估代码质量。维度：可测试性、可读性、可维护性。\n\n',
        messageTemplateEn: 'Please evaluate code quality from Kent Beck\'s (Test Engineer) standards. Dimensions: testability, readability, maintainability.\n\n',
        defaultMessage: '请以 Kent Beck（测试工程师）的标准，评估当前对话中代码的整体质量。\n维度：可测试性（依赖是否可注入？）、可读性（意图是否清晰？）、可维护性（修改一处会不会连锁爆炸？）。\n给出质量评分（1-10）和最值得改进的 1-3 个点。',
        defaultMessageEn: 'Please evaluate the overall code quality in the current conversation from Kent Beck\'s standards.\nDimensions: Testability (are dependencies injectable?), Readability (is intent clear?), Maintainability (does one change cascade?).\nGive a quality score (1-10) and the top 1-3 improvements.'
      }
    }
  },
  schneier: {
    name: 'Schneier',
    messagePrefix: '请以 Bruce Schneier（安全工程师）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Bruce Schneier\'s (Security Engineer) perspective:\n\n',
    actions: {
      'security-audit': {
        name: '安全审计', nameEn: 'Security Audit',
        messageTemplate: '请以 Bruce Schneier（安全工程师）的视角审计。假设攻击者已看到源码。关注注入攻击、认证漏洞、敏感数据暴露。\n\n',
        messageTemplateEn: 'Please audit from Bruce Schneier\'s (Security Engineer) perspective. Assume attacker has seen the source. Focus on injection attacks, auth vulnerabilities, sensitive data exposure.\n\n',
        defaultMessage: '请以 Bruce Schneier（安全工程师）的视角，对当前代码进行安全审计。\n假设攻击者已看到源码。关注：注入攻击（SQL/XSS/命令注入）、认证/授权漏洞、敏感数据暴露（日志/错误信息泄漏）、加密实践（硬编码密钥/弱算法）。\n按风险等级（高/中/低）排列，每个问题给出修复方案。',
        defaultMessageEn: 'Please perform a security audit on the current code from Bruce Schneier\'s perspective.\nAssume attacker has seen the source. Focus: injection attacks (SQL/XSS/command injection), auth/authorization vulnerabilities, sensitive data exposure (logs/error message leaks), crypto practices (hardcoded keys/weak algorithms).\nRank by risk level (high/medium/low), provide fix for each issue.'
      },
      'threat-model': {
        name: '威胁建模', nameEn: 'Threat Model',
        messageTemplate: '请以 Bruce Schneier（安全工程师）的方法论做威胁建模。聚焦最可能被利用的攻击面。\n\n',
        messageTemplateEn: 'Please build a threat model from Bruce Schneier\'s (Security Engineer) methodology. Focus on the most exploitable attack surfaces.\n\n',
        defaultMessage: '请以 Bruce Schneier（安全工程师）的方法论，为当前对话中讨论的系统做威胁建模。\n框架：识别资产（什么值得保护？）→ 识别威胁（谁会攻击？怎么攻击？）→ 识别漏洞（哪里可以突破？）→ 提出对策。\n聚焦最有可能被利用的 3 个攻击面。',
        defaultMessageEn: 'Please build a threat model for the system discussed from Bruce Schneier\'s methodology.\nFramework: Identify assets (what\'s worth protecting?) → Identify threats (who attacks? how?) → Identify vulnerabilities (where to breach?) → Propose countermeasures.\nFocus on the 3 most likely exploitable attack surfaces.'
      },
      'auth-review': {
        name: '认证审查', nameEn: 'Auth Review',
        messageTemplate: '请以 Bruce Schneier（安全工程师）的标准审查认证/授权方案。关注认证流程、token 管理、权限检查、越权风险。\n\n',
        messageTemplateEn: 'Please review auth/authorization from Bruce Schneier\'s (Security Engineer) standards. Focus on auth flow, token management, permission checks, privilege escalation.\n\n',
        defaultMessage: '请以 Bruce Schneier（安全工程师）的标准，审查当前对话中的认证/授权方案。\n关注：认证流程是否完整？token/session 管理是否安全？权限检查有没有遗漏？是否有越权风险？CSRF/CORS 是否正确配置？\n直接指出问题和修复方案。',
        defaultMessageEn: 'Please review the auth/authorization scheme in the current conversation from Bruce Schneier\'s standards.\nFocus: Is the auth flow complete? Is token/session management secure? Are permission checks missing? Any privilege escalation risks? Is CSRF/CORS properly configured?\nDirectly point out issues and fixes.'
      }
    }
  },
  rams: {
    name: 'Rams',
    messagePrefix: '请以 Dieter Rams（UI/UX 设计师）的设计原则回答：\n\n',
    messagePrefixEn: 'Please answer from Dieter Rams\'s (UI/UX Designer) design principles:\n\n',
    actions: {
      'ui-review': {
        name: '界面审查', nameEn: 'UI Review',
        messageTemplate: '请以 Dieter Rams（UI/UX 设计师）的设计原则审查界面。关注简洁性、一致性、可用性、视觉层次。\n\n',
        messageTemplateEn: 'Please review the UI from Dieter Rams\'s (UI/UX Designer) design principles. Focus on simplicity, consistency, usability, visual hierarchy.\n\n',
        defaultMessage: '请以 Dieter Rams（UI/UX 设计师）的设计原则，审查当前对话中的界面设计。\n原则：好的设计是尽可能少的设计。关注：信息层次是否清晰？操作是否符合直觉？视觉元素是否一致？有没有多余装饰？\n用 Rams 十大设计原则逐条审视。',
        defaultMessageEn: 'Please review the UI design in the current conversation from Dieter Rams\'s design principles.\nPrinciple: Good design is as little design as possible. Focus: Is information hierarchy clear? Are operations intuitive? Are visual elements consistent? Any unnecessary decoration?\nReview against Rams\' 10 design principles.'
      },
      'interaction': {
        name: '交互设计', nameEn: 'Interaction Design',
        messageTemplate: '请以 Dieter Rams（UI/UX 设计师）的标准设计交互方案。关注操作路径、反馈机制、容错设计。\n\n',
        messageTemplateEn: 'Please design interaction from Dieter Rams\'s (UI/UX Designer) standards. Focus on operation paths, feedback mechanisms, error tolerance.\n\n',
        defaultMessage: '请以 Dieter Rams（UI/UX 设计师）的标准，为当前对话中讨论的功能设计交互方案。\n关注：操作路径最短几步？每步有什么反馈？用户犯错时如何恢复？状态变化是否可感知？\n输出：交互流程图 + 关键状态描述。',
        defaultMessageEn: 'Please design an interaction scheme for the feature discussed from Dieter Rams\'s standards.\nFocus: Minimum steps for operation path? What feedback at each step? How to recover from user errors? Are state changes perceivable?\nOutput: Interaction flow + key state descriptions.'
      },
      'layout': {
        name: '布局优化', nameEn: 'Layout Optimization',
        messageTemplate: '请以 Dieter Rams（UI/UX 设计师）的标准优化布局。关注空间利用、视觉权重、对齐秩序。\n\n',
        messageTemplateEn: 'Please optimize layout from Dieter Rams\'s (UI/UX Designer) standards. Focus on space utilization, visual weight, alignment order.\n\n',
        defaultMessage: '请以 Dieter Rams（UI/UX 设计师）的标准，优化当前对话中讨论的页面布局。\n关注：视觉权重分布是否合理？留白是否足够？对齐是否有秩序？响应式适配策略？\n原则：每个像素都应该有意义。给出具体的布局调整建议。',
        defaultMessageEn: 'Please optimize the page layout discussed from Dieter Rams\'s standards.\nFocus: Is visual weight distribution balanced? Is whitespace sufficient? Is alignment orderly? Responsive adaptation strategy?\nPrinciple: Every pixel should have purpose. Give specific layout adjustment suggestions.'
      }
    }
  },
  graham: {
    name: 'Graham',
    messagePrefix: '请以 Paul Graham（技术写作专家）的写作风格回答：\n\n',
    messagePrefixEn: 'Please answer in Paul Graham\'s (Tech Writer / Evaluator) writing style:\n\n',
    actions: {
      'writing': {
        name: '技术写作', nameEn: 'Tech Writing',
        messageTemplate: '请以 Paul Graham（技术写作专家）的写作标准优化。删掉一切不增加信息量的字。用主动语态。用具体例子代替抽象描述。\n\n',
        messageTemplateEn: 'Please optimize from Paul Graham\'s (Tech Writer) writing standards. Remove all words that don\'t add information. Use active voice. Replace abstract descriptions with concrete examples.\n\n',
        defaultMessage: '请以 Paul Graham（技术写作专家）的写作标准，优化当前对话中的文档或文案。\n原则：删掉一切不增加信息量的字。用主动语态。用具体例子代替抽象描述。一个段落一个观点。\n输出优化后的版本，并标注主要改动点。',
        defaultMessageEn: 'Please optimize the documentation or copy in the current conversation from Paul Graham\'s writing standards.\nPrinciples: Remove all words that don\'t add information. Use active voice. Replace abstract descriptions with concrete examples. One point per paragraph.\nOutput: Optimized version with key changes annotated.'
      },
      'proposal-review': {
        name: '方案评估', nameEn: 'Proposal Review',
        messageTemplate: '请以 Paul Graham（YC 创始人 / 方案评估师）的标准评估方案。30 秒判断核心价值，然后追问薄弱点。\n\n',
        messageTemplateEn: 'Please evaluate the proposal from Paul Graham\'s (YC founder / Evaluator) standards. Judge core value in 30 seconds, then probe weak points.\n\n',
        defaultMessage: '请以 Paul Graham（YC 创始人）的标准，评估当前对话中讨论的技术方案。\n视角：这个方案解决的问题值不值得解决？方案是否过度复杂？有没有更简单的替代方案？风险在哪里？\n像评估 YC 申请一样：30 秒内判断核心价值，然后深入追问薄弱点。',
        defaultMessageEn: 'Please evaluate the technical proposal discussed from Paul Graham\'s (YC founder) standards.\nPerspective: Is the problem worth solving? Is the solution over-complex? Any simpler alternatives? Where are the risks?\nLike evaluating a YC application: judge core value in 30 seconds, then deep-dive into weak points.'
      },
      'explain': {
        name: '概念解释', nameEn: 'Explain',
        messageTemplate: '请以 Paul Graham（技术写作专家）的表达能力，用非技术人员能理解的方式解释。从日常生活中找类比。\n\n',
        messageTemplateEn: 'Please explain from Paul Graham\'s (Tech Writer) communication skills, in a way non-technical people can understand. Find analogies from daily life.\n\n',
        defaultMessage: '请以 Paul Graham（技术写作专家）的表达能力，用非技术人员能理解的方式解释当前对话中讨论的技术概念。\n方法：从日常生活中找类比。先给结论，再展开细节。避免术语，如果必须用就立即解释。\n目标读者：聪明但没有技术背景的人。',
        defaultMessageEn: 'Please explain the technical concepts discussed using Paul Graham\'s communication skills, in a way non-technical people can understand.\nMethod: Find analogies from daily life. Give conclusion first, then expand. Avoid jargon; if you must use it, explain immediately.\nTarget audience: Smart people without technical background.'
      }
    }
  },
  hightower: {
    name: 'Hightower',
    messagePrefix: '请以 Kelsey Hightower（DevOps 工程师）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Kelsey Hightower\'s (DevOps Engineer) perspective:\n\n',
    actions: {
      'deployment': {
        name: '部署审查', nameEn: 'Deployment Review',
        messageTemplate: '请以 Kelsey Hightower（DevOps 工程师）的标准审查部署方案。关注可重复性、回滚方案、零停机部署。\n\n',
        messageTemplateEn: 'Please review deployment from Kelsey Hightower\'s (DevOps Engineer) standards. Focus on repeatability, rollback plan, zero-downtime deployment.\n\n',
        defaultMessage: '请以 Kelsey Hightower（DevOps 工程师）的标准，审查当前对话中的部署方案。\n关注：部署流程是否可重复？回滚方案是否清晰？环境变量管理是否安全？健康检查是否配置？零停机部署是否可行？\n给出可直接执行的改进建议。',
        defaultMessageEn: 'Please review the deployment plan in the current conversation from Kelsey Hightower\'s standards.\nFocus: Is the deployment repeatable? Is the rollback plan clear? Is env var management secure? Are health checks configured? Is zero-downtime deployment feasible?\nGive directly actionable improvement suggestions.'
      },
      'cicd': {
        name: 'CI/CD 评估', nameEn: 'CI/CD Review',
        messageTemplate: '请以 Kelsey Hightower（DevOps 工程师）的标准评估 CI/CD 管道。关注构建可重现性、测试覆盖、部署门控。\n\n',
        messageTemplateEn: 'Please review CI/CD pipeline from Kelsey Hightower\'s (DevOps Engineer) standards. Focus on build reproducibility, test coverage, deployment gates.\n\n',
        defaultMessage: '请以 Kelsey Hightower（DevOps 工程师）的标准，评估当前对话中的 CI/CD 配置。\n关注：构建是否可重现？测试覆盖是否足够？部署阶段是否有审批门控？制品管理是否规范？pipeline 速度是否可接受？\n指出瓶颈和改进方案。',
        defaultMessageEn: 'Please evaluate the CI/CD configuration in the current conversation from Kelsey Hightower\'s standards.\nFocus: Are builds reproducible? Is test coverage sufficient? Are there deployment approval gates? Is artifact management proper? Is pipeline speed acceptable?\nIdentify bottlenecks and improvement plans.'
      },
      'infra': {
        name: '基础设施', nameEn: 'Infrastructure',
        messageTemplate: '请以 Kelsey Hightower（DevOps 工程师）的标准审查基础设施。关注 IaC、监控告警、日志、故障恢复。\n\n',
        messageTemplateEn: 'Please review infrastructure from Kelsey Hightower\'s (DevOps Engineer) standards. Focus on IaC, monitoring/alerting, logging, disaster recovery.\n\n',
        defaultMessage: '请以 Kelsey Hightower（DevOps 工程师）的标准，审查当前对话中的基础设施方案。\n关注：资源是否 IaC 管理？监控/告警是否覆盖关键指标？日志是否结构化可查询？故障恢复 RTO/RPO 是否明确？成本是否合理？\n给出架构图级别的改进建议。',
        defaultMessageEn: 'Please review the infrastructure plan in the current conversation from Kelsey Hightower\'s standards.\nFocus: Are resources IaC-managed? Do monitoring/alerts cover key metrics? Are logs structured and queryable? Are disaster recovery RTO/RPO defined? Are costs reasonable?\nGive architecture-level improvement suggestions.'
      }
    }
  },
  gregg: {
    name: 'Gregg',
    messagePrefix: '请以 Brendan Gregg（性能工程师）的方法论回答：\n\n',
    messagePrefixEn: 'Please answer from Brendan Gregg\'s (Performance Engineer) methodology:\n\n',
    actions: {
      'perf-analysis': {
        name: '性能分析', nameEn: 'Perf Analysis',
        messageTemplate: '请以 Brendan Gregg（性能工程师）的 USE 方法论分析性能瓶颈。从 CPU → 内存 → I/O → 网络 → 应用层排查。\n\n',
        messageTemplateEn: 'Please analyze performance bottlenecks using Brendan Gregg\'s (Performance Engineer) USE methodology. Check CPU → Memory → I/O → Network → Application layer.\n\n',
        defaultMessage: '请以 Brendan Gregg（性能工程师）的 USE 方法论，分析当前对话中代码/系统的性能瓶颈。\n方法：USE（Utilization, Saturation, Errors）。从上到下排查：CPU → 内存 → I/O → 网络 → 应用层。\n给出：瓶颈在哪里、如何验证（用什么工具/命令）、优化方案的预期收益。',
        defaultMessageEn: 'Please analyze performance bottlenecks in the current code/system using Brendan Gregg\'s USE methodology.\nMethod: USE (Utilization, Saturation, Errors). Top-down: CPU → Memory → I/O → Network → Application.\nOutput: Where is the bottleneck, how to verify (tools/commands), expected benefit of optimization.'
      },
      'tuning': {
        name: '系统调优', nameEn: 'Tuning',
        messageTemplate: '请以 Brendan Gregg（性能工程师）的方法论给出调优建议。每个建议给出参数、值、原因、验证方式。\n\n',
        messageTemplateEn: 'Please provide tuning recommendations from Brendan Gregg\'s (Performance Engineer) methodology. For each: parameter, value, reason, verification method.\n\n',
        defaultMessage: '请以 Brendan Gregg（性能工程师）的方法论，给出当前对话中系统的调优建议。\n聚焦：内核参数、运行时配置、连接池/线程池大小、缓存策略、GC 调优。\n每个建议给出：改什么参数、改成什么值、为什么、如何验证效果。不要给没法量化的建议。',
        defaultMessageEn: 'Please provide tuning recommendations for the system in the current conversation from Brendan Gregg\'s methodology.\nFocus: kernel parameters, runtime config, connection/thread pool sizes, caching strategy, GC tuning.\nFor each: what parameter to change, target value, why, how to verify. No non-quantifiable advice.'
      },
      'benchmark': {
        name: '基准测试', nameEn: 'Benchmark',
        messageTemplate: '请以 Brendan Gregg（性能工程师）的标准设计性能基准测试。明确测什么指标、用什么工具、如何消除噪声。\n\n',
        messageTemplateEn: 'Please design performance benchmarks from Brendan Gregg\'s (Performance Engineer) standards. Specify metrics, tools, and noise elimination.\n\n',
        defaultMessage: '请以 Brendan Gregg（性能工程师）的标准，为当前对话中的系统设计性能基准测试方案。\n要素：测什么指标（延迟/吞吐/资源占用）？用什么工具？测试数据怎么构造？如何消除噪声？基线怎么定？\n输出：可直接执行的 benchmark 脚本或步骤。',
        defaultMessageEn: 'Please design a performance benchmark plan for the system in the current conversation from Brendan Gregg\'s standards.\nElements: What metrics (latency/throughput/resource usage)? What tools? How to construct test data? How to eliminate noise? How to set baseline?\nOutput: Directly executable benchmark script or steps.'
      }
    }
  },
  codd: {
    name: 'Codd',
    messagePrefix: '请以 Edgar Codd（数据库专家 / 关系模型之父）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Edgar Codd\'s (Database / SQL Expert) perspective:\n\n',
    actions: {
      'sql-optimization': {
        name: 'SQL 优化', nameEn: 'SQL Optimization',
        messageTemplate: '请以 Edgar Codd（数据库专家）的标准优化 SQL。关注索引利用率、查询计划、N+1 问题、全表扫描。\n\n',
        messageTemplateEn: 'Please optimize SQL from Edgar Codd\'s (Database Expert) standards. Focus on index utilization, query plan, N+1 problem, full table scans.\n\n',
        defaultMessage: '请以 Edgar Codd（数据库专家）的标准，优化当前对话中的 SQL 查询。\n关注：是否利用了索引？查询计划是否合理？有没有 N+1 问题？是否存在全表扫描？JOIN 顺序是否最优？\n给出优化后的 SQL 和预期性能提升。',
        defaultMessageEn: 'Please optimize the SQL queries in the current conversation from Edgar Codd\'s standards.\nFocus: Are indexes utilized? Is the query plan reasonable? Any N+1 problems? Any full table scans? Is JOIN order optimal?\nProvide optimized SQL and expected performance improvement.'
      },
      'schema-design': {
        name: 'Schema 设计', nameEn: 'Schema Design',
        messageTemplate: '请以 Edgar Codd（数据库专家）的标准审查数据库 Schema。关注范式化、数据完整性、索引策略、扩展性。\n\n',
        messageTemplateEn: 'Please review database schema from Edgar Codd\'s (Database Expert) standards. Focus on normalization, data integrity, indexing strategy, scalability.\n\n',
        defaultMessage: '请以 Edgar Codd（数据库专家）的标准，审查当前对话中的数据库 Schema 设计。\n关注：是否适当范式化？数据完整性约束是否完整？索引策略是否合理？未来数据量增长时的扩展性？\n给出 Schema 优化建议和迁移方案。',
        defaultMessageEn: 'Please review the database schema design in the current conversation from Edgar Codd\'s standards.\nFocus: Is normalization appropriate? Are data integrity constraints complete? Is indexing strategy sound? Scalability for future data growth?\nProvide schema optimization suggestions and migration plan.'
      },
      'data-modeling': {
        name: '数据建模', nameEn: 'Data Modeling',
        messageTemplate: '请以 Edgar Codd（数据库专家）的标准设计数据模型。关注实体关系、约束条件、查询模式适配。\n\n',
        messageTemplateEn: 'Please design data model from Edgar Codd\'s (Database Expert) standards. Focus on entity relationships, constraints, query pattern adaptation.\n\n',
        defaultMessage: '请以 Edgar Codd（数据库专家）的标准，为当前对话中讨论的业务需求设计数据模型。\n方法：先理解业务实体和关系，再选择存储模型（关系型/文档型/图）。\n输出：ER 图描述 + 建表语句 + 索引建议 + 查询模式分析。',
        defaultMessageEn: 'Please design a data model for the business requirements discussed from Edgar Codd\'s standards.\nMethod: Understand business entities and relationships first, then choose storage model (relational/document/graph).\nOutput: ER diagram description + CREATE TABLE statements + index suggestions + query pattern analysis.'
      }
    }
  },
  knuth: {
    name: 'Knuth',
    messagePrefix: '请以 Donald Knuth（算法大师 / 《计算机程序设计艺术》作者）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Donald Knuth\'s (Algorithm Expert) perspective:\n\n',
    actions: {
      'algorithm-design': {
        name: '算法设计', nameEn: 'Algorithm Design',
        messageTemplate: '请以 Donald Knuth（算法专家）的标准设计算法。关注时间复杂度、空间复杂度、边界条件、正确性证明。\n\n',
        messageTemplateEn: 'Please design algorithm from Donald Knuth\'s (Algorithm Expert) standards. Focus on time complexity, space complexity, boundary conditions, correctness proof.\n\n',
        defaultMessage: '请以 Donald Knuth（算法专家）的标准，为当前对话中的问题设计算法方案。\n关注：时间复杂度和空间复杂度的权衡、边界条件的处理、算法正确性的论证。\n给出：算法描述 + 复杂度分析 + 关键边界用例。',
        defaultMessageEn: 'Please design an algorithm for the problem discussed from Donald Knuth\'s standards.\nFocus: Time/space complexity tradeoffs, boundary condition handling, algorithm correctness argumentation.\nOutput: Algorithm description + complexity analysis + key boundary test cases.'
      },
      'data-processing': {
        name: '数据处理', nameEn: 'Data Processing',
        messageTemplate: '请以 Donald Knuth（数据处理专家）的标准设计数据处理方案。关注数据流、批量 vs 流式、内存效率、容错。\n\n',
        messageTemplateEn: 'Please design data processing from Donald Knuth\'s (Data Processing Expert) standards. Focus on data flow, batch vs streaming, memory efficiency, fault tolerance.\n\n',
        defaultMessage: '请以 Donald Knuth（数据处理专家）的标准，设计当前对话中的数据处理方案。\n关注：数据量级和流向、批量处理还是流式处理、内存占用是否可控、错误数据如何处理。\n给出：处理管道设计 + 各环节的复杂度分析。',
        defaultMessageEn: 'Please design a data processing solution for the current conversation from Donald Knuth\'s standards.\nFocus: Data volume and flow direction, batch vs streaming, memory usage control, error data handling.\nOutput: Processing pipeline design + complexity analysis for each stage.'
      },
      'optimization': {
        name: '优化', nameEn: 'Optimization',
        messageTemplate: '请以 Donald Knuth（算法专家）的标准优化现有算法。"过早优化是万恶之源"——但真正的瓶颈要彻底解决。\n\n',
        messageTemplateEn: 'Please optimize from Donald Knuth\'s (Algorithm Expert) standards. "Premature optimization is the root of all evil" — but real bottlenecks must be solved thoroughly.\n\n',
        defaultMessage: '请以 Donald Knuth（算法专家）的标准，优化当前对话中的算法或数据处理逻辑。\n方法：先 profile 找到真正瓶颈，再针对性优化。"过早优化是万恶之源"——但已确认的瓶颈要彻底解决。\n给出：优化前后的复杂度对比和实测预期。',
        defaultMessageEn: 'Please optimize the algorithm or data processing logic in the current conversation from Donald Knuth\'s standards.\nMethod: Profile to find real bottlenecks first, then optimize targeted. "Premature optimization is the root of all evil" — but confirmed bottlenecks must be solved thoroughly.\nOutput: Before/after complexity comparison and expected measured improvement.'
      }
    }
  },
  thomas: {
    name: 'Thomas',
    messagePrefix: '请以 Dave Thomas（务实程序员 / 技术文档专家）的标准回答：\n\n',
    messagePrefixEn: 'Please answer from Dave Thomas\'s (Tech Doc Engineer) standards:\n\n',
    actions: {
      'api-docs': {
        name: 'API 文档', nameEn: 'API Docs',
        messageTemplate: '请以 Dave Thomas（技术文档专家）的标准编写 API 文档。关注完整性、示例代码、错误码说明。\n\n',
        messageTemplateEn: 'Please write API documentation from Dave Thomas\'s (Tech Doc Expert) standards. Focus on completeness, code examples, error code explanations.\n\n',
        defaultMessage: '请以 Dave Thomas（技术文档专家）的标准，为当前对话中的 API 编写文档。\n要素：接口描述、请求/响应格式、参数说明、示例代码、错误码和处理方式。\n原则：文档应该让新人在 5 分钟内能调通一个接口。',
        defaultMessageEn: 'Please write documentation for the API discussed from Dave Thomas\'s standards.\nElements: Interface description, request/response format, parameter explanations, code examples, error codes and handling.\nPrinciple: Documentation should let a newcomer make a successful API call within 5 minutes.'
      },
      'readme': {
        name: 'README', nameEn: 'README',
        messageTemplate: '请以 Dave Thomas（技术文档专家）的标准编写 README。关注快速上手、架构概览、常见问题。\n\n',
        messageTemplateEn: 'Please write README from Dave Thomas\'s (Tech Doc Expert) standards. Focus on quick start, architecture overview, FAQ.\n\n',
        defaultMessage: '请以 Dave Thomas（技术文档专家）的标准，为当前项目编写或优化 README。\n结构：一句话说明是什么 → 快速上手（3 步以内）→ 架构概览 → 配置说明 → 常见问题。\n原则：README 是项目的门面，30 秒内让读者决定是否继续。',
        defaultMessageEn: 'Please write or optimize the README for the current project from Dave Thomas\'s standards.\nStructure: One-sentence description → Quick start (3 steps max) → Architecture overview → Configuration → FAQ.\nPrinciple: README is the project\'s front door — let readers decide in 30 seconds whether to continue.'
      },
      'comment-review': {
        name: '注释审查', nameEn: 'Comment Review',
        messageTemplate: '请以 Dave Thomas（技术文档专家）的标准审查代码注释。关注注释必要性、准确性、是否过时。\n\n',
        messageTemplateEn: 'Please review code comments from Dave Thomas\'s (Tech Doc Expert) standards. Focus on necessity, accuracy, staleness.\n\n',
        defaultMessage: '请以 Dave Thomas（技术文档专家）的标准，审查当前对话中代码的注释质量。\n原则：好代码自己说话，注释只解释"为什么"而非"做什么"。删掉显而易见的注释，补充非直觉的决策注释。\n指出过时注释、误导性注释和缺失的关键注释。',
        defaultMessageEn: 'Please review code comment quality in the current conversation from Dave Thomas\'s standards.\nPrinciple: Good code speaks for itself. Comments explain "why" not "what". Remove obvious comments, add non-intuitive decision comments.\nIdentify stale comments, misleading comments, and missing critical comments.'
      }
    }
  },

  // ============================================================
  // 📈 交易团队 (6 roles)
  // ============================================================
  soros: {
    name: 'Soros',
    messagePrefix: '请以 George Soros（宏观策略师 / 反身性理论创始人）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from George Soros\'s (Macro Strategist / Reflexivity theorist) perspective:\n\n',
    actions: {
      'macro-analysis': {
        name: '宏观分析', nameEn: 'Macro Analysis',
        messageTemplate: '请以 George Soros（宏观策略师）的反身性框架分析。关注市场偏见与基本面的反馈循环。\n\n',
        messageTemplateEn: 'Please analyze from George Soros\'s (Macro Strategist) reflexivity framework. Focus on the feedback loop between market bias and fundamentals.\n\n',
        defaultMessage: '请以 George Soros（宏观策略师）的反身性框架，分析当前对话中讨论的市场或经济形势。\n方法：识别市场参与者的主流偏见 → 判断偏见与基本面的差距 → 分析反馈循环是加速还是反转。\n给出：当前处于反身性循环的哪个阶段？转折信号是什么？',
        defaultMessageEn: 'Please analyze the market or economic situation discussed from George Soros\'s reflexivity framework.\nMethod: Identify mainstream market bias → Judge gap between bias and fundamentals → Analyze if feedback loop is accelerating or reversing.\nOutput: What stage of the reflexivity cycle? What are the reversal signals?'
      },
      'risk-assessment': {
        name: '风险评估', nameEn: 'Risk Assessment',
        messageTemplate: '请以 George Soros（宏观策略师）的标准评估风险。"先生存，再赚钱"——关注尾部风险和仓位管理。\n\n',
        messageTemplateEn: 'Please assess risk from George Soros\'s (Macro Strategist) standards. "Survive first, make money second" — focus on tail risk and position management.\n\n',
        defaultMessage: '请以 George Soros（宏观策略师）的标准，评估当前对话中讨论的交易/投资方案的风险。\n原则："先生存，再赚钱"。关注：最大回撤能承受多少？尾部风险有多大？仓位是否留有安全边际？\n给出：风险敞口分析 + 仓位建议 + 止损位。',
        defaultMessageEn: 'Please assess the risk of the trade/investment discussed from George Soros\'s standards.\nPrinciple: "Survive first, make money second." Focus: How much max drawdown is acceptable? How large is the tail risk? Does the position have a safety margin?\nOutput: Risk exposure analysis + position suggestions + stop-loss levels.'
      },
      'thesis-review': {
        name: '论点审查', nameEn: 'Thesis Review',
        messageTemplate: '请以 George Soros（宏观策略师）的标准审查投资论点。追问假设是否成立、证伪条件是什么。\n\n',
        messageTemplateEn: 'Please review investment thesis from George Soros\'s (Macro Strategist) standards. Probe if assumptions hold and what the falsification conditions are.\n\n',
        defaultMessage: '请以 George Soros（宏观策略师）的标准，审查当前对话中的投资/交易论点。\n方法：拆解论点的核心假设 → 逐条追问每个假设是否成立 → 明确证伪条件（什么情况下放弃）。\n输出：论点评分 + 最薄弱的假设 + 建议的对冲方案。',
        defaultMessageEn: 'Please review the investment/trading thesis discussed from George Soros\'s standards.\nMethod: Break down core assumptions → Probe each assumption → Define falsification conditions (when to abandon).\nOutput: Thesis score + weakest assumption + recommended hedge.'
      }
    }
  },
  livermore: {
    name: 'Livermore',
    messagePrefix: '请以 Jesse Livermore（技术分析师 / 传奇交易员）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Jesse Livermore\'s (Technical Analyst / legendary trader) perspective:\n\n',
    actions: {
      'price-action': {
        name: '价格行为', nameEn: 'Price Action',
        messageTemplate: '请以 Jesse Livermore（技术分析师）的视角分析价格行为。关注关键价位、成交量变化、趋势强度。\n\n',
        messageTemplateEn: 'Please analyze price action from Jesse Livermore\'s (Technical Analyst) perspective. Focus on key levels, volume changes, trend strength.\n\n',
        defaultMessage: '请以 Jesse Livermore（技术分析师）的视角，分析当前对话中讨论的价格走势。\n关注：关键支撑/阻力位在哪里？成交量是否确认趋势？当前趋势的强度和持续性？\n用 Livermore 的"关键点"理论判断：是买入点、卖出点还是观望？',
        defaultMessageEn: 'Please analyze the price action discussed from Jesse Livermore\'s perspective.\nFocus: Where are key support/resistance levels? Does volume confirm the trend? Current trend strength and sustainability?\nUse Livermore\'s "pivotal point" theory: Is this a buy point, sell point, or watch?'
      },
      'pattern-recognition': {
        name: '图形识别', nameEn: 'Pattern Recognition',
        messageTemplate: '请以 Jesse Livermore（技术分析师）的经验识别图形模式。关注头肩顶底、突破回踩、量价背离。\n\n',
        messageTemplateEn: 'Please recognize chart patterns from Jesse Livermore\'s (Technical Analyst) experience. Focus on head-and-shoulders, breakout retests, volume-price divergence.\n\n',
        defaultMessage: '请以 Jesse Livermore（技术分析师）的经验，识别当前对话中讨论的价格图形中的交易信号。\n关注：是否存在经典图形（头肩、双底、旗形）？突破是否有效？量价关系是否健康？\n给出：图形识别结果 + 目标位测算 + 失效条件。',
        defaultMessageEn: 'Please identify trading signals in the price chart discussed from Jesse Livermore\'s experience.\nFocus: Are there classic patterns (head-and-shoulders, double bottom, flag)? Is the breakout valid? Is the volume-price relationship healthy?\nOutput: Pattern identification + target price calculation + invalidation conditions.'
      },
      'trade-plan': {
        name: '交易计划', nameEn: 'Trade Plan',
        messageTemplate: '请以 Jesse Livermore（技术分析师）的纪律制定交易计划。明确入场点、止损位、目标位、仓位。\n\n',
        messageTemplateEn: 'Please create a trade plan from Jesse Livermore\'s (Technical Analyst) discipline. Specify entry, stop-loss, target, and position size.\n\n',
        defaultMessage: '请以 Jesse Livermore（技术分析师）的纪律，为当前对话中讨论的标的制定交易计划。\n要素：入场条件和价位 → 止损位（必须明确）→ 目标位（分批止盈）→ 仓位大小（风险控制）。\n原则："截断亏损，让利润奔跑"。',
        defaultMessageEn: 'Please create a trade plan for the asset discussed from Jesse Livermore\'s discipline.\nElements: Entry conditions and price → Stop-loss (must be specific) → Target (scaled profit-taking) → Position size (risk control).\nPrinciple: "Cut losses short, let profits run."'
      }
    }
  },
  dalio: {
    name: 'Dalio',
    messagePrefix: '请以 Ray Dalio（经济研究员 / 经济机器理论创始人）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Ray Dalio\'s (Research / Economist) perspective:\n\n',
    actions: {
      'economic-analysis': {
        name: '经济分析', nameEn: 'Economic Analysis',
        messageTemplate: '请以 Ray Dalio（经济研究员）的经济机器框架分析。关注信贷周期、债务水平、央行政策空间。\n\n',
        messageTemplateEn: 'Please analyze from Ray Dalio\'s (Economist) economic machine framework. Focus on credit cycles, debt levels, central bank policy space.\n\n',
        defaultMessage: '请以 Ray Dalio（经济研究员）的经济机器框架，分析当前对话中讨论的经济形势。\n框架：经济 = 交易的总和。关注：短期债务周期处于什么位置？长期债务周期呢？央行还有多少政策空间？\n给出：当前经济阶段判断 + 资产配置建议。',
        defaultMessageEn: 'Please analyze the economic situation discussed from Ray Dalio\'s economic machine framework.\nFramework: Economy = sum of transactions. Focus: Where in the short-term debt cycle? Long-term debt cycle? How much policy space does the central bank have?\nOutput: Current economic stage assessment + asset allocation suggestions.'
      },
      'portfolio-review': {
        name: '组合审查', nameEn: 'Portfolio Review',
        messageTemplate: '请以 Ray Dalio（经济研究员）的全天候策略审查投资组合。关注风险平衡、相关性、尾部保护。\n\n',
        messageTemplateEn: 'Please review portfolio from Ray Dalio\'s (Economist) All-Weather strategy. Focus on risk parity, correlation, tail protection.\n\n',
        defaultMessage: '请以 Ray Dalio（经济研究员）的全天候策略标准，审查当前对话中的投资组合。\n关注：各资产类别的风险贡献是否平衡？相关性矩阵是否健康？在极端情景下（通胀飙升/通缩/衰退/繁荣）组合表现如何？\n给出：调仓建议和理由。',
        defaultMessageEn: 'Please review the investment portfolio discussed from Ray Dalio\'s All-Weather strategy standards.\nFocus: Is risk contribution balanced across asset classes? Is the correlation matrix healthy? Portfolio performance under extreme scenarios (inflation spike/deflation/recession/boom)?\nOutput: Rebalancing suggestions with reasoning.'
      },
      'research-report': {
        name: '研究报告', nameEn: 'Research Report',
        messageTemplate: '请以 Ray Dalio（经济研究员）的深度研究标准撰写分析报告。数据驱动、因果链清晰、结论可证伪。\n\n',
        messageTemplateEn: 'Please write an analysis report from Ray Dalio\'s (Economist) deep research standards. Data-driven, clear causal chain, falsifiable conclusions.\n\n',
        defaultMessage: '请以 Ray Dalio（经济研究员）的深度研究标准，撰写当前对话中讨论主题的分析报告。\n结构：核心论点（一句话）→ 支撑数据 → 因果链分析 → 风险和证伪条件 → 行动建议。\n原则：每个结论都要有数据支撑，每个建议都要可执行。',
        defaultMessageEn: 'Please write an analysis report on the topic discussed from Ray Dalio\'s deep research standards.\nStructure: Core thesis (one sentence) → Supporting data → Causal chain analysis → Risks and falsification conditions → Action recommendations.\nPrinciple: Every conclusion must have data support, every recommendation must be actionable.'
      }
    }
  },
  taleb: {
    name: 'Taleb',
    messagePrefix: '请以 Nassim Taleb（风控官 / 反脆弱理论作者）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Nassim Taleb\'s (Risk Manager / Antifragile author) perspective:\n\n',
    actions: {
      'risk-audit': {
        name: '风险审计', nameEn: 'Risk Audit',
        messageTemplate: '请以 Nassim Taleb（风控官）的标准审查风险敞口。关注黑天鹅事件、肥尾分布、杠杆水平。\n\n',
        messageTemplateEn: 'Please audit risk exposure from Nassim Taleb\'s (Risk Manager) standards. Focus on black swan events, fat-tail distribution, leverage levels.\n\n',
        defaultMessage: '请以 Nassim Taleb（风控官）的标准，审查当前对话中讨论的交易/投资方案的风险。\n方法：不要看平均情况，看极端情况。关注：肥尾风险有多大？有没有隐性杠杆？在 3 个标准差事件下会发生什么？\n原则：如果一个策略在尾部事件中会致命，再好的期望收益也不值得。',
        defaultMessageEn: 'Please audit the risk of the trade/investment discussed from Nassim Taleb\'s standards.\nMethod: Don\'t look at averages, look at extremes. Focus: How large is fat-tail risk? Any hidden leverage? What happens at a 3-sigma event?\nPrinciple: If a strategy is fatal in tail events, no expected return is worth it.'
      },
      'antifragile': {
        name: '反脆弱评估', nameEn: 'Antifragile Assessment',
        messageTemplate: '请以 Nassim Taleb（风控官）的反脆弱框架评估。关注策略在波动中是受益还是受损。\n\n',
        messageTemplateEn: 'Please assess from Nassim Taleb\'s (Risk Manager) antifragile framework. Focus on whether the strategy benefits or suffers from volatility.\n\n',
        defaultMessage: '请以 Nassim Taleb（风控官）的反脆弱框架，评估当前对话中的策略/系统。\n问题：这个系统在波动增加时是变好还是变差？是脆弱的（波动中受损）、健壮的（不受影响）、还是反脆弱的（波动中受益）？\n给出：脆弱性评分 + 如何增加反脆弱性的建议。',
        defaultMessageEn: 'Please assess the strategy/system discussed from Nassim Taleb\'s antifragile framework.\nQuestion: Does this system improve or worsen with increased volatility? Is it fragile (harmed by volatility), robust (unaffected), or antifragile (benefits from volatility)?\nOutput: Fragility score + recommendations to increase antifragility.'
      },
      'stress-test': {
        name: '压力测试', nameEn: 'Stress Test',
        messageTemplate: '请以 Nassim Taleb（风控官）的标准做压力测试。用极端但可能的场景测试系统韧性。\n\n',
        messageTemplateEn: 'Please stress test from Nassim Taleb\'s (Risk Manager) standards. Test system resilience with extreme but possible scenarios.\n\n',
        defaultMessage: '请以 Nassim Taleb（风控官）的标准，对当前对话中的投资组合/策略进行压力测试。\n场景：(1) 单日暴跌 10% (2) 流动性枯竭 (3) 相关性突然趋 1 (4) 连续亏损一个月。\n每个场景给出：预估损失、是否触发爆仓/清算、恢复所需时间。',
        defaultMessageEn: 'Please stress test the portfolio/strategy discussed from Nassim Taleb\'s standards.\nScenarios: (1) 10% single-day crash (2) Liquidity dry-up (3) Correlations suddenly converge to 1 (4) One month of consecutive losses.\nFor each: estimated loss, whether it triggers liquidation, recovery time needed.'
      }
    }
  },
  jones: {
    name: 'Jones',
    messagePrefix: '请以 Paul Tudor Jones（交易执行员 / 宏观交易大师）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Paul Tudor Jones\'s (Trade Executor / macro trading master) perspective:\n\n',
    actions: {
      'execution': {
        name: '执行计划', nameEn: 'Execution Plan',
        messageTemplate: '请以 Paul Tudor Jones（交易执行员）的标准制定执行计划。关注入场时机、分批建仓、滑点控制。\n\n',
        messageTemplateEn: 'Please create an execution plan from Paul Tudor Jones\'s (Trade Executor) standards. Focus on entry timing, scaling in, slippage control.\n\n',
        defaultMessage: '请以 Paul Tudor Jones（交易执行员）的标准，制定当前对话中交易的执行计划。\n关注：最佳入场时机窗口？分几批建仓？每批占比？如何控制滑点？市价还是限价？\n原则：纪律第一，计划内的亏损不是错误。',
        defaultMessageEn: 'Please create an execution plan for the trade discussed from Paul Tudor Jones\'s standards.\nFocus: Best entry timing window? How many tranches? Percentage per tranche? How to control slippage? Market or limit orders?\nPrinciple: Discipline first — planned losses are not mistakes.'
      },
      'position-sizing': {
        name: '仓位计算', nameEn: 'Position Sizing',
        messageTemplate: '请以 Paul Tudor Jones（交易执行员）的标准计算仓位。关注资金管理、单笔风险上限、相关性叠加。\n\n',
        messageTemplateEn: 'Please calculate position size from Paul Tudor Jones\'s (Trade Executor) standards. Focus on money management, single-trade risk limit, correlation stacking.\n\n',
        defaultMessage: '请以 Paul Tudor Jones（交易执行员）的标准，计算当前对话中讨论的交易的合理仓位。\n规则：单笔交易风险不超过总资金的 1-2%。考虑：与现有持仓的相关性、波动率调整、流动性约束。\n给出：建议仓位大小 + 计算过程 + 总组合风险影响。',
        defaultMessageEn: 'Please calculate the appropriate position size for the trade discussed from Paul Tudor Jones\'s standards.\nRule: Single trade risk no more than 1-2% of total capital. Consider: correlation with existing positions, volatility adjustment, liquidity constraints.\nOutput: Recommended position size + calculation + total portfolio risk impact.'
      },
      'trade-review': {
        name: '交易复盘', nameEn: 'Trade Review',
        messageTemplate: '请以 Paul Tudor Jones（交易执行员）的标准复盘交易。关注执行质量、决策过程、情绪控制。\n\n',
        messageTemplateEn: 'Please review the trade from Paul Tudor Jones\'s (Trade Executor) standards. Focus on execution quality, decision process, emotional control.\n\n',
        defaultMessage: '请以 Paul Tudor Jones（交易执行员）的标准，复盘当前对话中讨论的已完成交易。\n维度：入场逻辑是否正确？执行是否到位（时机/价位）？持仓过程中有没有违反纪律？出场是计划内还是情绪驱动？\n给出：可改进的具体环节和下次的行动项。',
        defaultMessageEn: 'Please review the completed trade discussed from Paul Tudor Jones\'s standards.\nDimensions: Was entry logic correct? Was execution on-point (timing/price)? Any discipline violations during holding? Was exit planned or emotion-driven?\nOutput: Specific areas for improvement and next-time action items.'
      }
    }
  },
  simons: {
    name: 'Simons',
    messagePrefix: '请以 Jim Simons（量化分析师 / 文艺复兴科技创始人）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Jim Simons\'s (Quant Analyst / Renaissance Technologies founder) perspective:\n\n',
    actions: {
      'quant-signal': {
        name: '量化信号', nameEn: 'Quant Signal',
        messageTemplate: '请以 Jim Simons（量化分析师）的方法论分析量化信号。关注统计显著性、过拟合风险、样本外表现。\n\n',
        messageTemplateEn: 'Please analyze quant signals from Jim Simons\'s (Quant Analyst) methodology. Focus on statistical significance, overfitting risk, out-of-sample performance.\n\n',
        defaultMessage: '请以 Jim Simons（量化分析师）的方法论，分析当前对话中讨论的交易信号或量化策略。\n关注：信号的统计显著性如何？有没有过拟合风险？样本外回测表现？夏普比率和最大回撤？\n原则：数据说话，直觉靠后。',
        defaultMessageEn: 'Please analyze the trading signal or quant strategy discussed from Jim Simons\'s methodology.\nFocus: Statistical significance of the signal? Overfitting risk? Out-of-sample backtest performance? Sharpe ratio and max drawdown?\nPrinciple: Data speaks, intuition follows.'
      },
      'backtest-review': {
        name: '回测审查', nameEn: 'Backtest Review',
        messageTemplate: '请以 Jim Simons（量化分析师）的标准审查回测结果。关注回测偏差、幸存者偏差、交易成本假设。\n\n',
        messageTemplateEn: 'Please review backtest results from Jim Simons\'s (Quant Analyst) standards. Focus on backtest bias, survivorship bias, transaction cost assumptions.\n\n',
        defaultMessage: '请以 Jim Simons（量化分析师）的标准，审查当前对话中的回测结果。\n关注：有没有前视偏差？幸存者偏差？交易成本和滑点假设是否现实？样本划分是否合理？\n指出回测中可能隐藏的陷阱，给出改进建议。',
        defaultMessageEn: 'Please review the backtest results discussed from Jim Simons\'s standards.\nFocus: Any look-ahead bias? Survivorship bias? Are transaction cost and slippage assumptions realistic? Is sample splitting reasonable?\nIdentify hidden traps in the backtest and provide improvement suggestions.'
      },
      'model-design': {
        name: '模型设计', nameEn: 'Model Design',
        messageTemplate: '请以 Jim Simons（量化分析师）的方法论设计量化模型。关注特征工程、模型选择、风险约束。\n\n',
        messageTemplateEn: 'Please design quant model from Jim Simons\'s (Quant Analyst) methodology. Focus on feature engineering, model selection, risk constraints.\n\n',
        defaultMessage: '请以 Jim Simons（量化分析师）的方法论，为当前对话中讨论的交易场景设计量化模型。\n框架：明确预测目标 → 特征工程 → 模型选择（简单优先）→ 风险约束 → 实盘对接。\n原则：可解释性和鲁棒性比精度更重要。',
        defaultMessageEn: 'Please design a quant model for the trading scenario discussed from Jim Simons\'s methodology.\nFramework: Define prediction target → Feature engineering → Model selection (simple first) → Risk constraints → Live trading integration.\nPrinciple: Interpretability and robustness matter more than precision.'
      }
    }
  },

  // ============================================================
  // ✍️ 写作团队 (4 roles)
  // ============================================================
  jinyong: {
    name: '金庸',
    messagePrefix: '请以金庸（武侠大师）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Jin Yong\'s (Wuxia Master) perspective:\n\n',
    actions: {
      'world-building': {
        name: '武侠世界观', nameEn: 'Wuxia World Building',
        messageTemplate: '请以金庸（武侠大师）的标准构建武侠世界观。关注门派体系、武功层次、江湖规矩、历史背景融合。\n\n',
        messageTemplateEn: 'Please build a wuxia world from Jin Yong\'s (Wuxia Master) standards. Focus on sect systems, martial arts hierarchy, jianghu rules, historical integration.\n\n',
        defaultMessage: '请以金庸（武侠大师）的标准，审查当前对话中的故事世界观设定。\n关注：门派体系是否层次分明？武功设定是否有合理的强弱梯度？江湖规矩是否自洽？有没有把虚构武侠与真实历史巧妙融合？\n原则：最好的武侠世界，让读者觉得"这个江湖真的存在过"。',
        defaultMessageEn: 'Please review the world-building discussed from Jin Yong\'s (Wuxia Master) standards.\nFocus: Is the sect system well-layered? Does the martial arts hierarchy have logical power gradients? Are the jianghu rules consistent? Is fictional wuxia skillfully woven with real history?\nPrinciple: The best wuxia world makes readers feel "this jianghu actually existed."'
      },
      'character-design': {
        name: '人物塑造', nameEn: 'Character Design',
        messageTemplate: '请以金庸（武侠大师）的标准塑造人物。关注性格复杂度、成长弧线、侠义精神、人物关系网。\n\n',
        messageTemplateEn: 'Please design characters from Jin Yong\'s (Wuxia Master) standards. Focus on personality complexity, growth arcs, chivalric spirit, relationship networks.\n\n',
        defaultMessage: '请以金庸（武侠大师）的标准，审查当前对话中的人物设计。\n关注：角色是否有内在矛盾（如乔峰的身份困境）？成长弧线是否自然？侠义精神如何体现？人物关系网是否丰富且合理？\n原则：好角色不是完美的，而是让读者又爱又恨、念念不忘的。',
        defaultMessageEn: 'Please review the character design discussed from Jin Yong\'s standards.\nFocus: Does the character have internal conflicts (like Qiao Feng\'s identity crisis)? Is the growth arc natural? How is chivalric spirit expressed? Is the relationship network rich and logical?\nPrinciple: Good characters aren\'t perfect — they\'re the ones readers love, hate, and can\'t forget.'
      },
      'plot-design': {
        name: '情节编排', nameEn: 'Plot Design',
        messageTemplate: '请以金庸（武侠大师）的标准编排情节。关注伏笔回收、多线交织、高潮迭起、结局升华。\n\n',
        messageTemplateEn: 'Please design plot from Jin Yong\'s (Wuxia Master) standards. Focus on foreshadowing payoff, multi-thread weaving, rising climaxes, ending sublimation.\n\n',
        defaultMessage: '请以金庸（武侠大师）的标准，审查当前对话中的情节设计。\n关注：伏笔是否在关键时刻漂亮回收？多条故事线是否交织紧密？高潮是否层层递进而非一蹴而就？结局是否超越了简单的善恶对决？\n方法：像金庸那样——用"草蛇灰线"的手法埋线，在最意想不到的地方揭开。',
        defaultMessageEn: 'Please review the plot design discussed from Jin Yong\'s standards.\nFocus: Is foreshadowing paid off beautifully at key moments? Are multiple storylines tightly woven? Do climaxes build progressively? Does the ending transcend simple good-vs-evil?\nMethod: Like Jin Yong — plant subtle seeds early, reveal them where least expected.'
      }
    }
  },
  zhouzi: {
    name: '肘子',
    messagePrefix: '请以会说话的肘子（网文天王）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Zhouzi\'s (Web Novel King) perspective:\n\n',
    actions: {
      'cool-factor': {
        name: '爽感设计', nameEn: 'Cool Factor Design',
        messageTemplate: '请以会说话的肘子（网文天王）的标准设计爽感。关注打脸节奏、装逼打脸循环、读者情绪高点、爽点密度。\n\n',
        messageTemplateEn: 'Please design cool factor from Zhouzi\'s (Web Novel King) standards. Focus on face-slapping rhythm, show-off cycles, reader emotional highs, cool point density.\n\n',
        defaultMessage: '请以会说话的肘子（网文天王）的标准，分析当前对话中的故事爽感设计。\n关注：主角有没有稳定的爽点输出？打脸节奏是否合理（铺垫→压制→反转→爽）？读者情绪曲线是否持续走高？有没有"闷段"让读者想弃书？\n原则：网文的核心是让读者追更停不下来。每一章都要有至少一个让人拍大腿的爽点。',
        defaultMessageEn: 'Please analyze the cool factor design discussed from Zhouzi\'s standards.\nFocus: Does the MC have steady cool-point output? Is the face-slapping rhythm right (setup → suppression → reversal → satisfaction)? Does the reader\'s emotional curve keep rising? Any dull stretches that make readers want to drop?\nPrinciple: Web novels must keep readers chasing updates. Every chapter needs at least one fist-pumping moment.'
      },
      'pacing': {
        name: '节奏把控', nameEn: 'Pacing Control',
        messageTemplate: '请以会说话的肘子（网文天王）的标准把控节奏。关注章末钩子、水字数的艺术、日更节奏、追更体验。\n\n',
        messageTemplateEn: 'Please control pacing from Zhouzi\'s (Web Novel King) standards. Focus on chapter-end hooks, padding art, daily update rhythm, reading-chase experience.\n\n',
        defaultMessage: '请以会说话的肘子（网文天王）的标准，分析当前对话中的写作节奏。\n关注：每章结尾是否有让读者忍不住点"下一章"的钩子？信息释放节奏是否合理？有没有拖沓灌水的段落？伏笔释放是否及时？\n原则：日更网文的命脉是留人。每章 3000-4000 字，节奏紧凑，章末必有悬念。像肘子那样——用幽默消解套路感，用反转制造惊喜。',
        defaultMessageEn: 'Please analyze writing pacing from Zhouzi\'s standards.\nFocus: Does each chapter end with a hook that makes readers click "next chapter"? Is information release pacing reasonable? Any padding or drag? Is foreshadowing revealed timely?\nPrinciple: Daily web novel survival depends on retention. 3000-4000 words per chapter, tight pacing, every chapter ends with suspense. Like Zhouzi — use humor to defuse formula fatigue, use reversals for surprises.'
      },
      'cheat-design': {
        name: '金手指设计', nameEn: 'Cheat System Design',
        messageTemplate: '请以会说话的肘子（网文天王）的标准设计金手指/升级体系。关注能力限制、升级节奏、战力体系、读者期待管理。\n\n',
        messageTemplateEn: 'Please design cheat/power system from Zhouzi\'s (Web Novel King) standards. Focus on ability limits, upgrade pacing, power system, reader expectation management.\n\n',
        defaultMessage: '请以会说话的肘子（网文天王）的标准，设计或审查当前对话中的金手指/升级体系。\n关注：金手指是否有明确的限制条件（无限制=无趣）？升级节奏是否让人期待（不能太快也不能太慢）？战力体系是否清晰不崩？有没有留出后期爆发的空间？\n原则：最好的金手指是"有限制但巧妙利用限制"。让读者觉得主角不是靠挂，而是靠脑子。',
        defaultMessageEn: 'Please design or review the cheat/power system discussed from Zhouzi\'s standards.\nFocus: Does the cheat have clear limitations (unlimited = boring)? Is the upgrade pace exciting (not too fast, not too slow)? Is the power system clear and consistent? Is there room for late-game power spikes?\nPrinciple: The best cheat system is "limited but cleverly exploited." Make readers feel the MC wins with brains, not hacks.'
      }
    }
  },
  qiongyao: {
    name: '琼瑶',
    messagePrefix: '请以琼瑶（言情宗师）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Chiung Yao\'s (Romance Master) perspective:\n\n',
    actions: {
      'emotion-writing': {
        name: '情感描写', nameEn: 'Emotion Writing',
        messageTemplate: '请以琼瑶（言情宗师）的标准描写情感。关注情感层次、内心独白、氛围渲染、感官细节。\n\n',
        messageTemplateEn: 'Please write emotions from Chiung Yao\'s (Romance Master) standards. Focus on emotional layers, inner monologue, atmosphere rendering, sensory details.\n\n',
        defaultMessage: '请以琼瑶（言情宗师）的标准，审查或优化当前对话中的情感描写。\n关注：情感表达是否有层次（不是直接说"我很难过"）？内心独白是否真实细腻？场景氛围是否烘托了情绪？有没有用感官细节（雨声、花香、微风）来传递情感？\n原则：最好的情感描写让读者不知不觉红了眼眶，而不是被作者喊着"你该哭了"。',
        defaultMessageEn: 'Please review or optimize the emotional writing discussed from Chiung Yao\'s standards.\nFocus: Are emotions expressed with layers (not just "I\'m sad")? Is the inner monologue authentic and delicate? Does the scene atmosphere enhance the mood? Are sensory details (rain, fragrance, breeze) used to convey feelings?\nPrinciple: The best emotional writing makes readers tear up without realizing — not because the author tells them to cry.'
      },
      'dialogue-design': {
        name: '对话设计', nameEn: 'Dialogue Design',
        messageTemplate: '请以琼瑶（言情宗师）的标准设计对话。关注情感张力、潜台词、语言美感、角色声音区分。\n\n',
        messageTemplateEn: 'Please design dialogue from Chiung Yao\'s (Romance Master) standards. Focus on emotional tension, subtext, linguistic beauty, character voice distinction.\n\n',
        defaultMessage: '请以琼瑶（言情宗师）的标准，优化当前对话中的角色对话。\n关注：对话中是否有情感张力（说的和想说的不一样）？语言是否优美且符合角色身份？每个角色的说话方式是否有区分度？关键对白是否让人过目不忘？\n原则：好的言情对话，表面是在说事，实际是在传情。一句"你走吧"，背后可能是千言万语。',
        defaultMessageEn: 'Please optimize the character dialogue discussed from Chiung Yao\'s standards.\nFocus: Is there emotional tension in dialogue (what\'s said vs. what\'s meant)? Is language beautiful and fitting to character identity? Are speaking styles distinct per character? Are key lines memorable?\nPrinciple: Good romance dialogue talks about things on the surface while conveying feelings underneath. A simple "just go" may carry a thousand unspoken words.'
      },
      'romance-arc': {
        name: '虐恋架构', nameEn: 'Romance Arc',
        messageTemplate: '请以琼瑶（言情宗师）的标准设计感情线。关注情感递进、误会与和解、虐心节奏、HE/BE 设计。\n\n',
        messageTemplateEn: 'Please design romance arc from Chiung Yao\'s (Romance Master) standards. Focus on emotional progression, misunderstandings & reconciliation, angst pacing, happy/bittersweet ending design.\n\n',
        defaultMessage: '请以琼瑶（言情宗师）的标准，设计或审查当前对话中的感情线架构。\n关注：感情递进是否自然（相遇→心动→试探→热恋→考验→结局）？虐点是否有价值（不是为虐而虐）？误会冲突是否合理？和解是否让人满足？结局是否呼应了故事主题？\n原则：好的虐恋不是把主角往死里整，而是让读者在心疼中看到爱情的力量。',
        defaultMessageEn: 'Please design or review the romance arc discussed from Chiung Yao\'s standards.\nFocus: Is emotional progression natural (meeting → attraction → testing → passion → trials → resolution)? Are angst points meaningful (not suffering for suffering\'s sake)? Are misunderstandings reasonable? Is reconciliation satisfying? Does the ending echo the story\'s theme?\nPrinciple: Good angst romance doesn\'t torture characters pointlessly — it shows readers the power of love through heartache.'
      }
    }
  },
  luxun: {
    name: '鲁迅',
    messagePrefix: '请以鲁迅（文学巨匠）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Lu Xun\'s (Literary Giant) perspective:\n\n',
    actions: {
      'satire': {
        name: '讽刺写作', nameEn: 'Satirical Writing',
        messageTemplate: '请以鲁迅（文学巨匠）的讽刺功力分析。关注反讽手法、社会批判深度、黑色幽默、以小见大。\n\n',
        messageTemplateEn: 'Please analyze with Lu Xun\'s (Literary Giant) satirical mastery. Focus on irony techniques, social critique depth, dark humor, revealing the big through the small.\n\n',
        defaultMessage: '请以鲁迅（文学巨匠）的讽刺功力，审查或优化当前对话中的文本。\n关注：讽刺是否精准（一针见血而非泛泛而谈）？反讽手法是否巧妙（让读者自己领悟，不是直接点破）？有没有"以小见大"——通过一个小细节揭示一个大问题？\n原则：最犀利的讽刺不是骂人，而是让被讽刺的人自己照镜子。像鲁迅那样——"哀其不幸，怒其不争"。',
        defaultMessageEn: 'Please review or optimize the text discussed with Lu Xun\'s satirical mastery.\nFocus: Is the satire precise (sharp and specific, not vague)? Is irony skillful (let readers realize it themselves)? Does it "reveal the big through the small" — exposing a major issue through one small detail?\nPrinciple: The sharpest satire isn\'t cursing — it\'s making the target look in the mirror. Like Lu Xun: "Pity their misfortune, anger at their resignation."'
      },
      'character-sketch': {
        name: '人物刻画', nameEn: 'Character Sketch',
        messageTemplate: '请以鲁迅（文学巨匠）的标准刻画人物。关注典型性、一两笔白描传神、人物与时代的关系。\n\n',
        messageTemplateEn: 'Please sketch characters from Lu Xun\'s (Literary Giant) standards. Focus on typicality, vivid depiction with minimal strokes, character-era relationship.\n\n',
        defaultMessage: '请以鲁迅（文学巨匠）的标准，审查或优化当前对话中的人物刻画。\n关注：人物是否具有典型性（代表一类人，而非只是一个人）？是否做到了"白描传神"——用最少的笔墨勾勒出最鲜明的形象？人物的命运是否折射了时代或环境的问题？\n方法：像鲁迅写阿Q、孔乙己那样——几笔就让一个人物活过来，而且活在每个读者身边。',
        defaultMessageEn: 'Please review or optimize character depiction from Lu Xun\'s standards.\nFocus: Is the character typical (representing a type of person, not just an individual)? Does it achieve "vivid depiction with minimal strokes" — creating the most vivid image with the fewest words? Does the character\'s fate reflect issues of the era or environment?\nMethod: Like Lu Xun wrote Ah Q and Kong Yiji — a few strokes bring a character to life, living beside every reader.'
      },
      'prose-craft': {
        name: '文笔锤炼', nameEn: 'Prose Craft',
        messageTemplate: '请以鲁迅（文学巨匠）的标准锤炼文笔。关注用词精准、句式力度、意象选择、删繁就简。\n\n',
        messageTemplateEn: 'Please refine prose from Lu Xun\'s (Literary Giant) standards. Focus on word precision, sentence power, imagery choice, cutting the unnecessary.\n\n',
        defaultMessage: '请以鲁迅（文学巨匠）的标准，锤炼当前对话中的文本段落。\n关注：每个词是否都是最精准的那个（换掉任何一个字都会变差）？句式是否有力度（短句如匕首，长句如重锤）？意象是否鲜明而非滥俗？有没有多余的字可以删掉？\n原则：好文章是改出来的。每一句都要经得起推敲。像鲁迅那样——"写完后至少看两遍，竭力将可有可无的字、句、段删去"。',
        defaultMessageEn: 'Please refine the text discussed from Lu Xun\'s prose standards.\nFocus: Is every word the most precise choice (replacing any would make it worse)? Do sentences have force (short ones like daggers, long ones like hammers)? Are images vivid and not clichéd? Are there unnecessary words to cut?\nPrinciple: Good writing is rewriting. Every sentence must withstand scrutiny. Like Lu Xun: "After writing, read at least twice and cut every dispensable word, sentence, and paragraph."'
      }
    }
  },

  // ============================================================
  // 🎬 视频团队 (4 roles)
  // ============================================================
  kubrick: {
    name: 'Kubrick',
    messagePrefix: '请以 Stanley Kubrick（导演 / 视觉总监）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Stanley Kubrick\'s (Director / Visual Director) perspective:\n\n',
    actions: {
      'narrative-pacing': {
        name: '叙事节奏', nameEn: 'Narrative Pacing',
        messageTemplate: '请以 Stanley Kubrick（导演）的标准审查叙事节奏。关注场景转换、信息揭示节奏、观众情绪管理。\n\n',
        messageTemplateEn: 'Please review narrative pacing from Stanley Kubrick\'s (Director) standards. Focus on scene transitions, information reveal rhythm, audience emotion management.\n\n',
        defaultMessage: '请以 Stanley Kubrick（导演）的标准，审查当前对话中的视频/故事的叙事节奏。\n关注：场景转换是否流畅？信息揭示的节奏是否合理？观众的情绪曲线是否被精心管理？\n原则：每一帧都应该有意义。节奏服务于情感，而不是相反。',
        defaultMessageEn: 'Please review the narrative pacing of the video/story discussed from Stanley Kubrick\'s standards.\nFocus: Are scene transitions smooth? Is the information reveal rhythm appropriate? Is the audience emotion curve carefully managed?\nPrinciple: Every frame should have meaning. Pacing serves emotion, not the other way around.'
      },
      'visual-concept': {
        name: '视觉概念', nameEn: 'Visual Concept',
        messageTemplate: '请以 Stanley Kubrick（视觉总监）的标准设计视觉概念。关注构图、色彩方案、空间运用、视觉隐喻。\n\n',
        messageTemplateEn: 'Please design visual concept from Stanley Kubrick\'s (Visual Director) standards. Focus on composition, color palette, spatial usage, visual metaphor.\n\n',
        defaultMessage: '请以 Stanley Kubrick（视觉总监）的标准，为当前对话中讨论的场景设计视觉概念。\n关注：构图遵循什么原则（对称？三分法？引导线？）？色彩方案传达什么情绪？空间如何表达角色关系？\n输出：每个关键场景的视觉方向描述。',
        defaultMessageEn: 'Please design visual concepts for the scenes discussed from Stanley Kubrick\'s standards.\nFocus: What composition principle (symmetry? rule of thirds? leading lines?)? What emotions does the color palette convey? How does space express character relationships?\nOutput: Visual direction description for each key scene.'
      },
      'scene-breakdown': {
        name: '场景拆解', nameEn: 'Scene Breakdown',
        messageTemplate: '请以 Stanley Kubrick（导演）的标准拆解场景。关注每场戏的核心目的、情绪转折、视听元素。\n\n',
        messageTemplateEn: 'Please break down scenes from Stanley Kubrick\'s (Director) standards. Focus on each scene\'s core purpose, emotional shift, audiovisual elements.\n\n',
        defaultMessage: '请以 Stanley Kubrick（导演）的标准，拆解当前对话中的场景或视频脚本。\n每场戏回答：这场戏存在的目的是什么？删掉它故事是否成立？情绪从 A 到 B 的转折是什么？用什么视听手段完成这个转折？\n删掉一切不必要的场景。',
        defaultMessageEn: 'Please break down the scenes or video script discussed from Stanley Kubrick\'s standards.\nFor each scene: What is its purpose? Does the story work without it? What is the emotional shift from A to B? What audiovisual means achieve this shift?\nCut all unnecessary scenes.'
      }
    }
  },
  kaufman: {
    name: 'Kaufman',
    messagePrefix: '请以 Charlie Kaufman（编剧 / 奥斯卡编剧大师）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Charlie Kaufman\'s (Screenwriter / Oscar-winning screenwriter) perspective:\n\n',
    actions: {
      'script-writing': {
        name: '脚本写作', nameEn: 'Script Writing',
        messageTemplate: '请以 Charlie Kaufman（编剧）的标准写脚本。关注叙事结构、角色深度、对话的潜台词层次。\n\n',
        messageTemplateEn: 'Please write script from Charlie Kaufman\'s (Screenwriter) standards. Focus on narrative structure, character depth, dialogue subtext layers.\n\n',
        defaultMessage: '请以 Charlie Kaufman（编剧）的标准，为当前对话中讨论的主题写脚本或台词。\n关注：叙事结构是否有新意？角色是否有内在矛盾（让他们有趣）？对话有几层意思（表面说的 vs 真正想说的）？\n原则：不要写观众已经猜到的东西。',
        defaultMessageEn: 'Please write a script or dialogue for the topic discussed from Charlie Kaufman\'s standards.\nFocus: Is the narrative structure fresh? Do characters have internal contradictions (making them interesting)? How many layers does the dialogue have (what\'s said vs what\'s meant)?\nPrinciple: Don\'t write what the audience already expects.'
      },
      'character-design': {
        name: '角色设计', nameEn: 'Character Design',
        messageTemplate: '请以 Charlie Kaufman（编剧）的标准设计角色。关注内在矛盾、欲望vs需求、角色弧线。\n\n',
        messageTemplateEn: 'Please design characters from Charlie Kaufman\'s (Screenwriter) standards. Focus on internal contradictions, want vs need, character arc.\n\n',
        defaultMessage: '请以 Charlie Kaufman（编剧）的标准，设计当前对话中的角色。\n维度：他想要什么（欲望）vs 他真正需要什么（需求）？内在矛盾是什么？他的弧线终点在哪里？\n好角色定义：给他一个不可能的选择，看他怎么选。',
        defaultMessageEn: 'Please design the characters discussed from Charlie Kaufman\'s standards.\nDimensions: What does the character want (desire) vs what do they truly need? What is their internal contradiction? Where does their arc end?\nGood character definition: Give them an impossible choice and see what they choose.'
      },
      'narrative-structure': {
        name: '叙事结构', nameEn: 'Narrative Structure',
        messageTemplate: '请以 Charlie Kaufman（编剧）的标准设计叙事结构。关注非线性叙事、视角转换、结构与主题的呼应。\n\n',
        messageTemplateEn: 'Please design narrative structure from Charlie Kaufman\'s (Screenwriter) standards. Focus on non-linear narrative, perspective shifts, structure-theme resonance.\n\n',
        defaultMessage: '请以 Charlie Kaufman（编剧）的标准，为当前对话中的故事设计叙事结构。\n思考：线性叙事够不够？时间线打乱会不会更好？多视角叙事能否揭示更多层次？结构本身能否成为主题的一部分？\n输出：结构方案 + 每个结构选择的理由。',
        defaultMessageEn: 'Please design narrative structure for the story discussed from Charlie Kaufman\'s standards.\nConsider: Is linear narrative sufficient? Would shuffled timeline be better? Can multiple perspectives reveal more layers? Can the structure itself become part of the theme?\nOutput: Structure plan + reasoning for each structural choice.'
      }
    }
  },
  spielberg: {
    name: 'Spielberg',
    messagePrefix: '请以 Steven Spielberg（分镜师 / 视觉叙事大师）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Steven Spielberg\'s (Storyboard / Visual Storyteller) perspective:\n\n',
    actions: {
      'storyboard': {
        name: '分镜设计', nameEn: 'Storyboard',
        messageTemplate: '请以 Steven Spielberg（分镜师）的标准设计分镜。关注镜头语言、画面构图、运动方向、情绪引导。\n\n',
        messageTemplateEn: 'Please design storyboard from Steven Spielberg\'s (Storyboard Artist) standards. Focus on shot language, frame composition, movement direction, emotion guidance.\n\n',
        defaultMessage: '请以 Steven Spielberg（分镜师）的标准，为当前对话中的场景设计分镜。\n每个镜头说明：景别（远/中/近/特写）、机位角度、运动方式（推/拉/摇/移/固定）、画面内容、情绪目标。\n原则：镜头是讲故事的语言，不是记录的工具。',
        defaultMessageEn: 'Please design a storyboard for the scenes discussed from Steven Spielberg\'s standards.\nFor each shot: shot size (wide/medium/close-up/extreme close-up), camera angle, movement (push/pull/pan/track/static), frame content, emotional goal.\nPrinciple: Shots are the language of storytelling, not a recording tool.'
      },
      'shot-design': {
        name: '镜头方案', nameEn: 'Shot Design',
        messageTemplate: '请以 Steven Spielberg（视觉叙事师）的标准设计镜头方案。关注画面叙事力、情感传达、观众视线引导。\n\n',
        messageTemplateEn: 'Please design shots from Steven Spielberg\'s (Visual Storyteller) standards. Focus on visual narrative power, emotional conveyance, audience gaze direction.\n\n',
        defaultMessage: '请以 Steven Spielberg（视觉叙事师）的标准，设计当前对话中关键场景的镜头方案。\n关注：用什么景别传达什么情感？观众的视线应该被引导到哪里？运镜如何配合情绪变化？\n给出：每个关键时刻的镜头选择和理由。',
        defaultMessageEn: 'Please design shots for the key scenes discussed from Steven Spielberg\'s standards.\nFocus: What shot size conveys what emotion? Where should the audience\'s gaze be directed? How does camera movement match emotional changes?\nOutput: Shot choice and reasoning for each key moment.'
      },
      'visual-storytelling': {
        name: '视觉叙事', nameEn: 'Visual Storytelling',
        messageTemplate: '请以 Steven Spielberg（视觉叙事师）的标准用画面讲故事。"不要用嘴说，用镜头演"。\n\n',
        messageTemplateEn: 'Please tell the story visually from Steven Spielberg\'s (Visual Storyteller) standards. "Show, don\'t tell."\n\n',
        defaultMessage: '请以 Steven Spielberg（视觉叙事师）的标准，用画面语言重新表达当前对话中用文字描述的情节。\n原则："Show, don\'t tell"——能用画面表达的不要用台词说。\n方法：找到每场戏的核心情感 → 设计一个画面来承载它 → 用镜头运动来加强。',
        defaultMessageEn: 'Please re-express the plot described in text using visual language from Steven Spielberg\'s standards.\nPrinciple: "Show, don\'t tell" — if it can be expressed visually, don\'t use dialogue.\nMethod: Find each scene\'s core emotion → Design a frame to carry it → Use camera movement to enhance it.'
      }
    }
  },
  schoonmaker: {
    name: 'Schoonmaker',
    messagePrefix: '请以 Thelma Schoonmaker（剪辑师 / 三届奥斯卡最佳剪辑）的视角回答：\n\n',
    messagePrefixEn: 'Please answer from Thelma Schoonmaker\'s (Editor / 3-time Oscar-winning editor) perspective:\n\n',
    actions: {
      'editing-rhythm': {
        name: '剪辑节奏', nameEn: 'Editing Rhythm',
        messageTemplate: '请以 Thelma Schoonmaker（剪辑师）的标准审查剪辑节奏。关注切点选择、场景转换、信息密度。\n\n',
        messageTemplateEn: 'Please review editing rhythm from Thelma Schoonmaker\'s (Editor) standards. Focus on cut point selection, scene transitions, information density.\n\n',
        defaultMessage: '请以 Thelma Schoonmaker（剪辑师）的标准，审查当前对话中的视频/脚本的剪辑节奏。\n关注：每个镜头的最佳切点在哪里？场景转换是否流畅？信息密度是否均匀？有没有可以删掉的冗余段落？\n原则：好的剪辑让观众感觉不到剪辑的存在。',
        defaultMessageEn: 'Please review the editing rhythm of the video/script discussed from Thelma Schoonmaker\'s standards.\nFocus: Where is the best cut point for each shot? Are scene transitions smooth? Is information density even? Any redundant segments to cut?\nPrinciple: Good editing makes the audience unaware of the editing.'
      },
      'sequence-design': {
        name: '序列设计', nameEn: 'Sequence Design',
        messageTemplate: '请以 Thelma Schoonmaker（剪辑师）的标准设计剪辑序列。关注画面衔接、节奏变化、情绪递进。\n\n',
        messageTemplateEn: 'Please design editing sequence from Thelma Schoonmaker\'s (Editor) standards. Focus on visual continuity, rhythm variation, emotional progression.\n\n',
        defaultMessage: '请以 Thelma Schoonmaker（剪辑师）的标准，为当前对话中的场景设计剪辑序列。\n关注：镜头之间的视觉连贯性、节奏的加速/减速、情绪的层层递进。\n给出：镜头排列顺序 + 每个切点的时机 + 转场方式建议。',
        defaultMessageEn: 'Please design an editing sequence for the scenes discussed from Thelma Schoonmaker\'s standards.\nFocus: Visual continuity between shots, rhythm acceleration/deceleration, emotional layer-by-layer progression.\nOutput: Shot arrangement order + timing for each cut point + transition method suggestions.'
      },
      'final-cut': {
        name: '最终审片', nameEn: 'Final Cut',
        messageTemplate: '请以 Thelma Schoonmaker（剪辑师）的标准做最终审片。关注整体节奏、情绪曲线、观众注意力管理。\n\n',
        messageTemplateEn: 'Please do final cut review from Thelma Schoonmaker\'s (Editor) standards. Focus on overall rhythm, emotion curve, audience attention management.\n\n',
        defaultMessage: '请以 Thelma Schoonmaker（剪辑师）的标准，对当前对话中的完整视频脚本做最终审片建议。\n维度：整体节奏是否有呼吸感？情绪曲线是否完整？观众注意力有没有断裂的地方？结尾是否有力？\n给出：需要收紧的段落 + 需要留白的地方 + 最终时长建议。',
        defaultMessageEn: 'Please provide final cut review suggestions for the complete video script discussed from Thelma Schoonmaker\'s standards.\nDimensions: Does overall rhythm have breathing room? Is the emotion curve complete? Any audience attention breaks? Is the ending powerful?\nOutput: Segments to tighten + places needing space + final duration recommendation.'
      }
    }
  }
};

// ============================================================
// Message Construction Functions
// ============================================================

/**
 * Extract the focus/description line from a messageTemplate.
 * Takes the part after the first period/。and before the trailing \n\n
 */
function extractFocusLine(template) {
  if (!template) return '';
  // Remove trailing \n\n
  const trimmed = template.replace(/\n\n$/, '');
  // Find the part after "。" or ". " (the focus description)
  const zhMatch = trimmed.match(/。(.+)$/);
  if (zhMatch) return zhMatch[1];
  const enMatch = trimmed.match(/\.\s+(.+)$/);
  if (enMatch) return enMatch[1];
  return trimmed;
}

/**
 * Build multi-expert message for multiple selections.
 * @param {Array<{role: string, action: string|null}>} selections
 * @param {string} userText
 * @param {boolean} isZh
 * @returns {{ displayPrompt: string, effectivePrompt: string }}
 */
function buildMultiExpertMessage(selections, userText, isZh) {
  const lines = selections.map((s, i) => {
    const role = EXPERT_ROLES[s.role];
    if (!role) return `${i + 1}. ${s.role}`;
    const action = s.action ? role.actions[s.action] : null;
    const focusLine = action
      ? extractFocusLine(isZh ? action.messageTemplate : action.messageTemplateEn)
      : '';
    const name = role.name;
    const actionLabel = action
      ? `（${isZh ? action.name : action.nameEn}）`
      : '';
    return `${i + 1}. ${name}${actionLabel}：${focusLine}`;
  });

  const header = userText
    ? (isZh ? '请分别从以下专家视角分析：' : 'Please analyze from the following expert perspectives:')
    : (isZh ? '请分别从以下专家视角分析当前对话中的代码：' : 'Please analyze the current code from the following expert perspectives:');

  const body = lines.join('\n');
  const effectivePrompt = userText
    ? `${header}\n\n${body}\n\n${userText}`
    : `${header}\n\n${body}`;

  // displayPrompt: for multi-selection without text, show @Role·Action labels
  const displayLabels = selections.map(s => {
    const role = EXPERT_ROLES[s.role];
    if (!role) return `@${s.role}`;
    if (s.action && role.actions[s.action]) {
      const actionDef = role.actions[s.action];
      return `@${role.name}·${isZh ? actionDef.name : actionDef.nameEn}`;
    }
    return `@${role.name}`;
  });

  return {
    displayPrompt: userText || displayLabels.join(' '),
    effectivePrompt
  };
}

/**
 * 构造帮帮团 user message
 * @param {Array<{role: string, action: string|null}>} selections
 * @param {string} userText - 用户输入的文字（可能为空）
 * @param {string} language - 'zh-CN' or 'en'
 * @returns {{ displayPrompt: string, effectivePrompt: string }}
 */
export function buildExpertMessage(selections, userText, language = 'zh-CN') {
  const isZh = language === 'zh-CN';

  if (!selections || selections.length === 0) {
    return { displayPrompt: userText, effectivePrompt: userText };
  }

  // 单选场景
  if (selections.length === 1) {
    const { role, action } = selections[0];
    const roleDef = EXPERT_ROLES[role];
    if (!roleDef) return { displayPrompt: userText, effectivePrompt: userText };

    let effectivePrompt;
    let displayLabel;

    if (action && roleDef.actions[action]) {
      const actionDef = roleDef.actions[action];
      if (userText) {
        // 场景 A：Action + 用户文字
        effectivePrompt = (isZh ? actionDef.messageTemplate : actionDef.messageTemplateEn) + userText;
      } else {
        // 场景 B：Action + 无文字
        effectivePrompt = isZh ? actionDef.defaultMessage : actionDef.defaultMessageEn;
      }
      displayLabel = `@${roleDef.name}·${isZh ? actionDef.name : actionDef.nameEn}`;
    } else {
      // 场景 C：纯角色 + 用户文字（场景 D 被前端阻止）
      effectivePrompt = (isZh ? roleDef.messagePrefix : roleDef.messagePrefixEn) + userText;
      displayLabel = `@${roleDef.name}`;
    }

    return {
      displayPrompt: userText || displayLabel,
      effectivePrompt
    };
  }

  // 多选场景
  return buildMultiExpertMessage(selections, userText, isZh);
}

export { EXPERT_ROLES };
