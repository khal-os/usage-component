{{/*
Nome do objeto de um servico. `namePrefix` vazio => o nome e a propria chave do
servico, que e o que o operador digita no kubectl.
*/}}
{{- define "kos.name" -}}
{{- $prefix := .root.Values.namePrefix | default "" -}}
{{- if $prefix -}}
{{- printf "%s-%s" $prefix .name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Namespace. Vazio nos values => namespace do release (sob Argo, o
destination.namespace da Application). CONTRATO §5: nunca hardcodar.
*/}}
{{- define "kos.namespace" -}}
{{- default .Release.Namespace .Values.namespace -}}
{{- end -}}

{{/* Labels comuns. `.root` = contexto raiz, `.name` = nome do servico. */}}
{{- define "kos.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/part-of: {{ .root.Chart.Name }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
khal.ai/surface: {{ .root.Values.common.surface | quote }}
{{- with .root.Values.common.client }}
khal.ai/client: {{ . | quote }}
{{- end }}
{{- with .root.Values.common.environment }}
khal.ai/environment: {{ . | quote }}
{{- end }}
{{- end -}}

{{- define "kos.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/*
Resolucao da IMAGEM — o unico lugar do chart que decide qual binario roda.

Ordem: `image.digest` do proprio servico (override raro) -> `pins[image.name]`
do values do ambiente. Falha FECHADO em tres casos, todos deliberados:
  · sem digest         -> a branch nunca foi buildada; renderizar `:latest`
                          silenciosamente e como nao ter esteira;
  · digest placeholder -> mesma coisa, mas com a mentira de parecer pinado;
  · digest fora do formato sha256:<64 hex> -> tag disfarcada de digest.
*/}}
{{- define "kos.image" -}}
{{- $root := .root -}}
{{- $name := .name -}}
{{- $img := .image -}}
{{- $key := $img.name | default $name -}}
{{- $pin := (get ($root.Values.pins | default dict) $key) | default dict -}}
{{- $repo := $img.repository | default (get ($root.Values.images | default dict) $key | default dict).repository -}}
{{- if not $repo -}}
{{- fail (printf "servico/carga '%s': image.repository nao resolvido (nem no servico, nem em images.%s.repository)" $name $key) -}}
{{- end -}}
{{- $digest := $img.digest | default $pin.digest | default "" -}}
{{- if not $digest -}}
{{- fail (printf "servico/carga '%s': sem digest. Pine com deploy/gitops-pin.sh <env> <json name->digest> <sha40> — o chart NAO renderiza tag." $name) -}}
{{- end -}}
{{- if eq $digest $root.Values.placeholderDigest -}}
{{- fail (printf "servico/carga '%s': digest e o PLACEHOLDER (%s). Esta branch nunca foi buildada; a lane dev tem de rodar antes. Falha fechada de proposito." $name $root.Values.placeholderDigest) -}}
{{- end -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}
{{- fail (printf "servico/carga '%s': digest '%s' nao casa ^sha256:[0-9a-f]{64}$" $name $digest) -}}
{{- end -}}
{{- printf "%s@%s" $repo $digest -}}
{{- end -}}

{{/* gitSha efetivo (servico > pin do ambiente). Vazio nunca passa: as lanes de
     promocao leem ISTO de volta do render para medir frescor. */}}
{{- define "kos.gitSha" -}}
{{- $root := .root -}}
{{- $img := .image -}}
{{- $key := $img.name | default .name -}}
{{- $pin := (get ($root.Values.pins | default dict) $key) | default dict -}}
{{- $sha := $img.gitSha | default $pin.gitSha | default "" -}}
{{- if not (regexMatch "^[0-9a-f]{40}$" $sha) -}}
{{- fail (printf "servico/carga '%s': image.gitSha ('%s') nao e 40 hex minusculos. Sem ele o guard de frescor das lanes de promocao vira decoracao." .name $sha) -}}
{{- end -}}
{{- $sha -}}
{{- end -}}

{{/*
Recursos: preset OU bloco literal, nunca os dois (a schema tambem reprova; aqui
e o cinto — quem renderiza fora do CI nao passa pela schema do `helm install`).
*/}}
{{- define "kos.resources" -}}
{{- $root := .root -}}
{{- $svc := .svc -}}
{{- if and $svc.preset $svc.resources -}}
{{- fail (printf "'%s': declare `preset` OU `resources`, nunca os dois" .name) -}}
{{- end -}}
{{- if $svc.resources -}}
{{- toYaml $svc.resources -}}
{{- else if $svc.preset -}}
{{- $p := get $root.Values.presets $svc.preset -}}
{{- if not $p -}}{{- fail (printf "'%s': preset '%s' nao existe (use S, M ou L)" .name $svc.preset) -}}{{- end -}}
{{- toYaml $p -}}
{{- else -}}
{{- fail (printf "'%s': sem `preset` nem `resources` — pod sem request e pod que o scheduler empurra para qualquer node e o kubelet mata primeiro" .name) -}}
{{- end -}}
{{- end -}}

{{/* Nome do Secret materializado pelo ESO para um servico. */}}
{{- define "kos.envSecretName" -}}
{{- printf "%s-env" (include "kos.name" (dict "root" .root "name" .name)) -}}
{{- end -}}

{{/*
Bloco `env:` de um servico. So configuracao NAO-secreta entra como literal; toda
credencial chega por `envFrom` do Secret do ESO. A schema reprova valor literal
em chave de secret (senha/token/key/secret/password).

Duas fontes, nesta ordem:
  `env:`         lista [{name, value}] em deploy/values.yaml — a FORMA, igual em
                 todo ambiente. Lista porque e assim que o contrato a descreve e
                 porque ler uma lista ordenada e mais facil que ler um mapa.
  `envOverride:` MAPA name -> value em deploy/values-<env>.yaml. Helm SUBSTITUI
                 listas em vez de mesclar; se o ambiente tivesse de redeclarar a
                 lista inteira para trocar uma URL, um dia alguem esqueceria
                 metade dela e o pod subiria com defaults invisiveis. Mapa mescla.

A saida sai ORDENADA por nome: render nao-deterministico transforma todo diff do
Argo (e toda revisao humana) em ruido.
*/}}
{{- define "kos.env" -}}
{{- $acc := dict -}}
{{- range .svc.env -}}
{{- $_ := set $acc .name (.value | toString) -}}
{{- end -}}
{{- range $k, $v := (.svc.envOverride | default dict) -}}
{{- $_ := set $acc $k ($v | toString) -}}
{{- end -}}
{{- range $k := (keys $acc | sortAlpha) }}
- name: {{ $k }}
  value: {{ get $acc $k | quote }}
{{- end }}
{{- end -}}

{{/*
Paths do Secrets Manager de um workload. Entrada absoluta (comeca com "/") passa
inteira; entrada relativa recebe `secretsPathPrefix` do ambiente. E o que permite
`secrets: [app, mongo]` em deploy/values.yaml (forma, env-agnostica) virar
/hapvida/<env>/kos/components/{app,mongo} sem repetir a lista em tres arquivos.
*/}}
{{- define "kos.secretPaths" -}}
{{- $root := .root -}}
{{- $prefix := $root.Values.secretsPathPrefix | default "" -}}
{{- $out := list -}}
{{- range .spec.secrets -}}
{{- if hasPrefix "/" . -}}
{{- $out = append $out . -}}
{{- else -}}
{{- if not $prefix -}}{{- fail (printf "secret relativo '%s' sem `secretsPathPrefix` no values do ambiente" .) -}}{{- end -}}
{{- $out = append $out (printf "%s/%s" (trimSuffix "/" $prefix) .) -}}
{{- end -}}
{{- end -}}
{{- toYaml $out -}}
{{- end -}}

{{/* securityContext de POD — non-root fixo (CONTRATO §5). As imagens do
     usage-component nao declaram USER; o uid vem daqui. */}}
{{- define "kos.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .svc.runAsUser | default 1000 }}
runAsGroup: {{ .svc.runAsGroup | default 1000 }}
fsGroup: {{ .svc.fsGroup | default 1000 }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* securityContext de CONTAINER. readOnlyRootFilesystem so quando o servico
     declara `tmpDir: true` (senao o processo escreveria em rootfs read-only e
     morreria no primeiro arquivo temporario). */}}
{{- define "kos.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: {{ .svc.tmpDir | default false }}
capabilities:
  drop: [ALL]
{{- end -}}

{{/*
Probe. Duas formas, e so duas:
  http: { path, port?, initialDelaySeconds?, periodSeconds?, timeoutSeconds?, failureThreshold? }
  exec: { command: [...] , ...os mesmos knobs }
Servico sem readiness e reprovado pela schema — um pod que entra no Service sem
criterio nenhum e um 502 esperando a hora certa.
*/}}
{{- define "kos.probe" -}}
{{- $p := .probe -}}
{{- if $p.command }}
exec:
  command:
    {{- toYaml $p.command | nindent 4 }}
{{- else if $p.path }}
httpGet:
  path: {{ $p.path | quote }}
  port: {{ $p.port | default .port }}
  scheme: HTTP
{{- else -}}
{{- fail (printf "'%s': probe sem `path` (http) nem `command` (exec)" .name) -}}
{{- end }}
initialDelaySeconds: {{ $p.initialDelaySeconds | default 10 }}
periodSeconds: {{ $p.periodSeconds | default 10 }}
timeoutSeconds: {{ $p.timeoutSeconds | default 3 }}
failureThreshold: {{ $p.failureThreshold | default 6 }}
{{- with $p.successThreshold }}
successThreshold: {{ . }}
{{- end }}
{{- end -}}

{{/* Servicos habilitados, em ordem estavel (o render tem de ser deterministico
     — diff do Argo e revisao humana dependem disso). */}}
{{- define "kos.enabledServices" -}}
{{- $out := list -}}
{{- range $name, $svc := .Values.services -}}
{{- if $svc.enabled -}}{{- $out = append $out $name -}}{{- end -}}
{{- end -}}
{{- toYaml (sortAlpha $out) -}}
{{- end -}}
