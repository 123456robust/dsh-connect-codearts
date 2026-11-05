window.__ModuleLoader__.load({
  id: 'dsh-connect-codearts',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 浏览器插件名。 */
    const name = 'dsh-connect-codearts-client'
    /** 需要的客户端服务。 */
    const inject = ['slots', 'locale']

    /** 卡片文案的本地化命名空间。 */
    const COPY_NS = 'settings.codearts'
    /** 设置命名空间候选：宿主可能用任一种拼写挂载。 */
    const SETTINGS_NAMESPACE_CANDIDATES = ['dsh-connect-codearts', 'include:dsh-connect-codearts', 'codearts']
    /** 本插件拥有的 provider 路由。 */
    const CODEARTS_PROVIDER = 'codearts'
    /** 状态接口路径，与 Host 半部分一致。 */
    const STATUS_PATH = '/plugins/dsh-connect-codearts/status'

    /** 中英文案。 */
    const COPY = {
      zh: {
        'card.title': '华为云 CodeArts / MaaS',
        'card.description': '把华为云 CodeArts（ModelArts Studio）上的模型接入 DSH。签名由插件自己完成，不需要另外运行代理脚本。',
        'card.credentials': '凭据',
        'card.credentialsOk': '已就绪',
        'card.credentialsMissing': '未找到凭据',
        'card.credentialsHint': '在 ~/.config/huaweicloud/credentials.json 写入 {"ak": "...", "sk": "..."}，或设置环境变量 CODEARTS_AK / CODEARTS_SK。',
        'card.region': '区域',
        'card.credentialRegionPrefix': '凭据来自',
        'card.upstream': '上游端点',
        'card.models': '模型',
        'card.modelsHint': '只列出实测可服务的模型。多模态模型可以读图；文字模型收到图片时会自动折叠成文字说明，避免污染会话。',
        'card.multimodal': '多模态',
        'card.text': '文字',
        'card.loading': '正在读取状态…',
        'card.unavailable': '读不到插件状态，Host 半部分可能还没就绪。',
        'card.refresh': '刷新',
        'composer.label': 'CodeArts',
        'composer.ready': '凭据就绪',
        'composer.missing': '缺少凭据',
      },
      en: {
        'card.title': 'Huawei Cloud CodeArts / MaaS',
        'card.description': 'Connect Huawei Cloud CodeArts (ModelArts Studio) models to DSH. The plugin signs requests itself, so no separate proxy script is needed.',
        'card.credentials': 'Credentials',
        'card.credentialsOk': 'Ready',
        'card.credentialsMissing': 'Not found',
        'card.credentialsHint': 'Write {"ak": "...", "sk": "..."} to ~/.config/huaweicloud/credentials.json, or set CODEARTS_AK / CODEARTS_SK.',
        'card.region': 'Region',
        'card.credentialRegionPrefix': 'credential from',
        'card.upstream': 'Upstream endpoint',
        'card.models': 'Models',
        'card.modelsHint': 'Only models verified to be servable are listed. Multimodal models can read images; text models get image parts folded into a text note so a session never gets poisoned.',
        'card.multimodal': 'Multimodal',
        'card.text': 'Text',
        'card.loading': 'Reading status…',
        'card.unavailable': 'Cannot read plugin status; the Host half may not be ready yet.',
        'card.refresh': 'Refresh',
        'composer.label': 'CodeArts',
        'composer.ready': 'Credentials ready',
        'composer.missing': 'Credentials missing',
      },
    }

    /**
     * 读取宿主当前的模型选择。
     * @param {object|undefined} projection `modelSelection` 投影。
     * @returns {string|undefined} 选中的 provider id。
     */
    function selectedProviderOf(projection) {
      const provider = (projection?.next ?? projection?.lastUsed)?.provider
      return typeof provider === 'string' && provider !== '' ? provider : undefined
    }

    /**
     * 拉取插件状态。
     * @returns {Promise<object|undefined>} 状态对象，失败返回 undefined。
     */
    async function fetchStatus() {
      try {
        const response = await fetch(STATUS_PATH, { headers: { Accept: 'application/json' } })
        if (!response.ok) return undefined
        return await response.json()
      } catch {
        return undefined
      }
    }

    /**
     * 通用小钩子：取一次状态，支持手动刷新。
     * @returns {{status: object|undefined, loading: boolean, reload: () => void}} 状态与刷新函数。
     */
    function useStatus() {
      const [status, setStatus] = React.useState(undefined)
      const [loading, setLoading] = React.useState(true)
      const [revision, setRevision] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        setLoading(true)
        fetchStatus().then((next) => {
          if (!alive) return
          setStatus(next)
          setLoading(false)
        })
        return () => {
          alive = false
        }
      }, [revision])
      return { status, loading, reload: () => setRevision((value) => value + 1) }
    }

    /** 一行键值对。 */
    function Row(props) {
      return h(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' } },
        h('span', { style: { color: 'var(--dsw-alias-text-secondary)', minWidth: 96 } }, props.label),
        h('span', { style: { color: 'var(--dsw-alias-text-primary)', wordBreak: 'break-all' } }, props.value),
      )
    }

    /** 设置页里的插件卡片。 */
    function CodeArtsCard(props) {
      const { t } = props
      const { status, loading, reload } = useStatus()

      const children = [h('div', { key: 'title', style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, t('card.title'))]

      children.push(
        h('div', { key: 'desc', style: { color: 'var(--dsw-alias-text-secondary)', marginBottom: 12, lineHeight: 1.5 } }, t('card.description')),
      )

      if (loading && status === undefined) {
        children.push(h('div', { key: 'loading', style: { color: 'var(--dsw-alias-text-secondary)' } }, t('card.loading')))
      } else if (status === undefined) {
        children.push(h('div', { key: 'unavailable', style: { color: 'var(--dsw-alias-text-secondary)' } }, t('card.unavailable')))
      } else {
        const credentials = status.credentials ?? {}
        // 生效区域来自设置；凭据文件里的 region 只在两者不一致时作为补充说明，
        // 否则读者会以为签名发去了另一个区域。
        const effectiveRegion = status.region ?? credentials.region ?? '—'
        const regionLine = credentials.region && credentials.region !== status.region
          ? `${effectiveRegion} · ${t('card.credentialRegionPrefix')} ${credentials.region}`
          : effectiveRegion
        children.push(
          h(
            'div',
            { key: 'facts', style: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12 } },
            h(Row, { label: t('card.credentials'), value: `${credentials.ok ? t('card.credentialsOk') : t('card.credentialsMissing')}${credentials.ak ? ` · ${credentials.ak}` : ''}` }),
            h(Row, { label: t('card.region'), value: regionLine }),
            h(Row, { label: t('card.upstream'), value: status.upstream ?? '—' }),
          ),
        )
        if (!credentials.ok) {
          children.push(
            h('div', { key: 'hint', style: { color: 'var(--dsw-alias-text-secondary)', marginBottom: 12, lineHeight: 1.5, fontSize: 13 } }, t('card.credentialsHint')),
          )
        }
        const models = Array.isArray(status.models) ? status.models : []
        children.push(
          h('div', { key: 'modelsLabel', style: { fontWeight: 600, marginBottom: 4 } }, t('card.models')),
          h(
            'div',
            { key: 'models', style: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8 } },
            models.map((model) =>
              h(Row, {
                key: model.id,
                label: model.id,
                value: model.multimodal ? t('card.multimodal') : t('card.text'),
              }),
            ),
          ),
          h('div', { key: 'modelsHint', style: { color: 'var(--dsw-alias-text-secondary)', fontSize: 13, lineHeight: 1.5 } }, t('card.modelsHint')),
        )
      }

      children.push(
        h(
          'button',
          {
            key: 'refresh',
            type: 'button',
            onClick: reload,
            style: {
              marginTop: 12,
              padding: '4px 12px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-default)',
              background: 'transparent',
              color: 'var(--dsw-alias-text-primary)',
              cursor: 'pointer',
              fontSize: 13,
            },
          },
          t('card.refresh'),
        ),
      )

      return h('div', { style: { padding: '4px 0 8px' } }, children)
    }

    /** 输入框里的胶囊读数：只在本插件当家时出现。 */
    function CodeArtsPill(props) {
      const { t, useProjection } = props
      const projection = useProjection === undefined ? undefined : useProjection('modelSelection')
      const { status } = useStatus()
      if (selectedProviderOf(projection) !== CODEARTS_PROVIDER) return null
      if (status === undefined) return null
      const ready = status.credentials?.ok === true
      return h(
        'div',
        {
          title: ready ? t('composer.ready') : t('composer.missing'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 8px',
            borderRadius: 999,
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--dsw-alias-text-secondary)',
            border: '1px solid var(--dsw-alias-border-default)',
          },
        },
        h('span', {
          style: {
            width: 6,
            height: 6,
            borderRadius: 999,
            background: ready ? 'var(--dsw-alias-status-success)' : 'var(--dsw-alias-status-warning)',
          },
        }),
        h('span', null, t('composer.label')),
      )
    }

    /**
     * 注册入口。
     * @param {object} ctx 客户端上下文。
     */
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(COPY_NS, COPY), 'dsh-connect-codearts: settings copy')
        const t = ctx.locale.bind(COPY_NS)
        const forms = ctx.get('configForms')

        /** 当前绑定的设置 scope（宿主可能还没服务该命名空间）。 */
        let settingsScope

        /**
         * 注册全部槽位。
         * @returns {Array<() => void>} 释放函数。
         */
        const registerSlots = () => {
          const disposers = []
          const registerCard = (slotName, key) => {
            try {
              disposers.push(
                ctx.slots.inject(slotName, () =>
                  ctx.slots.register(
                    {
                      name: slotName,
                      key,
                      priority: 30,
                      inject: () => (settingsScope === undefined ? { t } : { t, settingsScope }),
                    },
                    CodeArtsCard,
                  ),
                ),
              )
            } catch (error) {
              console.error(`[dsh-connect-codearts] card slot "${slotName}" failed to register (host provider unaffected):`, error)
            }
          }

          registerCard('plugins.bundle.config', 'dsh-connect-codearts')
          registerCard('plugins.row.config', 'dsh-connect-codearts#dsh-connect-codearts')

          try {
            disposers.push(
              ctx.slots.inject('conversation.input.left', () =>
                ctx.slots.register(
                  {
                    name: 'conversation.input.left',
                    id: 'dsh-connect-codearts-composer-pill',
                    order: 6,
                    locale: COPY_NS,
                    inject: () => (settingsScope === undefined ? { t } : { t, settingsScope }),
                  },
                  CodeArtsPill,
                ),
              ),
            )
          } catch (error) {
            console.error('[dsh-connect-codearts] composer pill slot failed to register (host provider unaffected):', error)
          }

          return disposers
        }

        let liveDisposers = []

        /** 重注册：设置命名空间到货后需要重新绑定闭包。 */
        const rebindSlots = () => {
          for (const dispose of liveDisposers) {
            try {
              dispose()
            } catch {
              /* 已经释放过就算了 */
            }
          }
          liveDisposers = registerSlots()
        }

        if (forms === undefined || typeof forms.whileServed !== 'function') {
          if (forms !== undefined) {
            let ns = SETTINGS_NAMESPACE_CANDIDATES[0]
            try {
              const served = forms.describe().getSnapshot().view?.namespaces ?? []
              const hit = served.find((entry) => SETTINGS_NAMESPACE_CANDIDATES.includes(entry.ns) || /codearts/i.test(entry.ns))
              if (hit !== undefined) ns = hit.ns
            } catch {
              /* 镜像还没到，用声明名 */
            }
            settingsScope = forms.get(ns)
          }
          liveDisposers = registerSlots()
          return
        }

        ctx.effect(
          () =>
            forms.whileServed(SETTINGS_NAMESPACE_CANDIDATES, (served) => {
              const ns =
                SETTINGS_NAMESPACE_CANDIDATES.find((candidate) => served.has(candidate)) ?? [...served].find((entry) => /codearts/i.test(entry))
              settingsScope = ns === undefined ? undefined : forms.get(ns)
              rebindSlots()
              return () => {
                for (const dispose of liveDisposers) {
                  try {
                    dispose()
                  } catch {
                    /* ignore */
                  }
                }
                liveDisposers = []
              }
            }),
          'dsh-connect-codearts: settings namespace binding',
        )
        rebindSlots()
      } catch (error) {
        console.error('[dsh-connect-codearts] client apply failed:', error)
      }
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    module.exports.name = name
    return module.exports
  },
})
