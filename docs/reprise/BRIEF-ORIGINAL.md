# NUERA DEV — PROMPT MAÎTRE DE DÉVELOPPEMENT INTÉGRAL

Tu es le responsable technique et produit chargé de **concevoir, initialiser et développer Nuera Dev de A à Z**. Le résultat attendu est une application web **réellement fonctionnelle, sécurisée, responsive, maintenable et prête à être déployée**, fidèle aux maquettes Figma. Ne livre ni prototype statique, ni simple frontend, ni plan sans exécution.

**Travaille de manière autonome, proactive et continue.** Prends les décisions de réalisation nécessaires, utilise les outils et sous-agents disponibles lorsque c'est pertinent, intègre et vérifie le travail au fur et à mesure. Ne sollicite pas de validation pour des choix techniques ou UX ordinaires. **Ne t'arrête qu'une fois la définition de terminé satisfaite**, sauf obstacle externe réel (accès, secret ou autorisation impossible à obtenir) : dans ce cas, finalise tout le reste et signale précisément ce qui reste à raccorder.

## 1. Point de départ : dépôt Git entièrement vide

**Nuera Dev n'existe pas encore dans ce dépôt.** Le repository distant est créé mais ne contient aucun socle applicatif. Tu dois **tout initialiser toi-même**, sans supposer que des composants, services, conventions, fichiers de configuration ou instructions de dépôt sont déjà présents.

1. Inspecte le dépôt et ses métadonnées Git (`remote`, branche par défaut, état du worktree), ainsi que les rares fichiers éventuellement présents. Préserve les fichiers déjà fournis et évite de réinitialiser un dépôt qui possède déjà son `.git`.
2. Explore **entièrement le projet Figma de Nuera Dev** et le style guide du workspace avant de choisir l'organisation des composants et des routes. Classe les écrans, états et parcours à réaliser.
3. Initialise la stack définie ci-dessous, l'arborescence, les dépendances, les conventions, le `README`, le `.gitignore`, le `.env.example`, les tests et les configurations de qualité.
4. **Crée un `CLAUDE.md` à la racine dès les fondations**, puis enrichis-le continuellement de pratiques validées et de leçons utiles ; respecte aussi tout éventuel `AGENTS.md` fourni ultérieurement.
5. Tiens un **suivi persistant et concis de l'avancement** dans le dépôt (réalisé, restant, décisions et vérifications). Construis un ordre d'exécution, puis **implémente immédiatement** ; ne t'arrête pas à la planification.

**Hiérarchie des sources :** les maquettes Figma et leur design system font autorité pour le visuel et les parcours ; ce prompt fixe le périmètre fonctionnel et les exigences de qualité ; le code et les décisions techniques validées deviennent progressivement la référence d'implémentation. En cas d'écart, résous-le proprement et documente brièvement l'arbitrage.

## 2. Figma : interfaces entièrement maquettées

Le **MCP Figma est connecté** et tu as normalement accès au workspace de Nuera Studio. Les **maquettes desktop et mobile de Nuera Dev sont désormais toutes réalisées**, dans la page `NUERA DEV — WEB APP`, avec le style guide et les composants existants du workspace.

**Écrans attendus dans les deux formats :** Accueil, Bibliothèque des projets, Ajout de projet, Détail/configuration d'un projet, Workspace Claude Code, Sessions/historique, Intégrations et Paramètres/administration ; ajoute les modales, tiroirs et variantes réellement présents dans Figma.

- Explore le bon fichier, **toutes les pages et tous les écrans pertinents**, ainsi que les composants, variables/tokens, typographies, couleurs, grilles, espacements, modales, variantes et états. Établis la correspondance entre maquettes, routes, composants et comportements.
- **Reproduis les interfaces fidèlement**, sans réinterprétation artistique gratuite : structure, densité, composants, espacements, responsive, hiérarchie, navigation et interactions. Utilise les actifs et conventions du design system existant.
- Implémente **desktop et mobile** comme de véritables expériences fonctionnelles. Les vues mobiles ne doivent pas être de simples desktops compressés.
- Si un état nécessaire, une variation ou une vue secondaire manque réellement dans Figma, **conçois-le toi-même dans le même langage graphique** en respectant la logique du produit. Cette liberté ne justifie pas de modifier les écrans déjà définis.
- Tous les éléments visibles doivent correspondre à un comportement réel : chargement, vide, succès, erreur, déconnexion, permissions, confirmation, actions, navigation, formulaires et feedback. Aucun bouton factice.

## 3. Produit et contexte d'exploitation

**Nuera Studio** est une agence web française à l'identité premium, éditoriale, sobre et soignée. Son infrastructure comprend des VPS OVH, GitHub et Coolify. Nuera Dev est une **application personnelle distincte de Nuera OS**, destinée à centraliser le développement depuis n'importe quel PC, navigateur ou téléphone.

**Objectif quotidien :** ouvrir un dépôt GitHub cloné sur un VPS, démarrer ou reprendre une session Claude Code, envoyer des instructions, suivre son exécution, gérer les autorisations, consulter les fichiers et les diffs, puis réaliser ses commits, push et pull requests **sans devoir constamment changer d'outil**.

**Infrastructure cible :**

- **VPS-1 :** Coolify central existant, responsable des déploiements.
- **VPS-3 :** hébergement prévu de Nuera Dev, de ses services, des projets clonés, des worktrees et de Claude Code.
- **VPS-4 :** autres environnements professionnels ; ne pas y installer ni exécuter Nuera Dev par défaut.
- **Domaine prévu :** `dev.nuera.studio`, à configurer ultérieurement via DNS, HTTPS et Coolify.

Nuera Dev est conçu d'abord pour **un utilisateur principal**. Concentre le produit sur son travail de développement : pas de CRM, de facturation, d'hébergeur parallèle ni de fonctionnalités décoratives sans bénéfice réel. **L'intégration Git doit toutefois être complète pour les opérations quotidiennes**, pas réduite à des liens vers GitHub.

## 4. Stack et architecture à initialiser

**Crée un seul dépôt applicatif Next.js full-stack**, sans microservices métier superflus :

- **Next.js App Router, React, TypeScript strict, Tailwind CSS, pnpm**, avec composants réutilisables construits selon Figma. Choisis des bibliothèques d'interface éprouvées uniquement lorsqu'elles accélèrent réellement l'intégration du style guide.
- **Backend dans Next.js** (Route Handlers / Server Actions selon le besoin), validation serveur avec **Zod**, séparation claire présentation / domaine / accès aux données / intégrations.
- **PostgreSQL + Drizzle ORM**, schéma relationnel cohérent et migrations versionnées pour projets, paramètres, sessions, connexions, opérations et audit léger. Prévois une instance locale reproductible pour le développement et une base distincte à raccorder au VPS via Coolify. Le dépôt doit être prêt à l'emploi avec des variables d'environnement, sans secrets intégrés.
- **Authentification éprouvée avec session sécurisée et MFA**, sans système de login artisanal ; contrôle des permissions sur chaque action côté serveur. Une seule identité utilisateur suffit en V1.
- **Flux temps réel adapté** pour les statuts, journaux et interactions de session ; évite le polling excessif.
- **Un service d'exécution de sessions séparé du cycle de vie de Next.js lorsque nécessaire**, mais conservé dans le même dépôt et avec la même stack TypeScript. Il doit piloter des processus longs, isolés, persistants et contrôlés ; un redéploiement du frontend ne doit pas effacer les dépôts ni interrompre inutilement les sessions.

**Ne confonds pas le backend web avec un shell privilégié.** Les opérations Git, terminal et Claude doivent passer par un exécuteur à privilèges restreints, avec chemins autorisés, contrôles d'accès, limites de ressources, gestion des erreurs et traçabilité. Ne donne pas au conteneur web d'accès root ni de socket Docker privilégiée sans nécessité démontrée.

## 5. Claude Code et abonnement Max : contrainte impérative

Le propriétaire souhaite utiliser **son abonnement Claude Max avec le Claude Code CLI officiel**, **pas une API Anthropic facturée à l'usage**. C'est une contrainte de produit et de conformité, pas un détail reportable.

- Examine la **documentation officielle actuelle** et les capacités réelles du CLI, de Remote Control et des sessions persistantes avant de développer l'intégration.
- **N'intercepte, n'extrais, ne réutilise et ne fais jamais transiter les tokens OAuth de Claude Max comme une API privée.** N'installe pas de proxy non officiel ni de mécanisme de contournement des modalités d'accès ou des quotas.
- Privilégie une **utilisation interactive du CLI officiel non modifié**, connectée par son utilisateur au moyen du parcours Anthropic prévu ; évalue la possibilité d'un terminal web sécurisé pilotant cette session. **Vérifie sa conformité et ses limites au lieu de la supposer acquise.**
- Si une conversation native entièrement reconstruite depuis l'interface Nuera Dev n'est pas prise en charge avec cet abonnement, **ne la simule pas** : réalise le reste du Workspace, expose le terminal interactif uniquement si son usage est autorisé, ou utilise l'ouverture de **Remote Control officiel** comme solution fonctionnelle. Documente exactement l'écart par rapport à Figma.
- L'absence de connexion Claude Max dans l'environnement de développement ne doit pas bloquer l'ensemble du projet : implémente les états « connexion requise », « session indisponible » et les branchements nécessaires, sans faux succès ni clé factice.

## 6. Périmètre fonctionnel à développer entièrement

La navigation principale comporte **Accueil, Projets, Sessions, Intégrations, Paramètres**. Le **Workspace** s'ouvre depuis un projet ou une session. Respecte le découpage effectif de Figma ; les rubriques ci-dessous fixent les capacités attendues, pas le nombre de composants ou de routes.

### 01 — Accueil

- **Vue d'ensemble :** santé réelle du VPS (CPU, RAM, stockage et disponibilité), état Claude Code, projets récents.
- **Activité :** sessions en cours, dernières modifications/commits Git, événements significatifs.
- **Actions rapides :** ouvrir un projet, démarrer ou reprendre une session, accéder directement à un élément nécessitant une action.

### 02 — Projets

- **Bibliothèque :** connecter GitHub, lister les dépôts autorisés, rechercher, ajouter en favori, cloner et archiver localement sans supprimer le dépôt distant.
- **Gestion Git :** statut et synchronisation, branches, création/sélection, pull, résolution ou signalement des conflits, distinction claire du dépôt distant et de ses clones/worktrees.
- **Configuration :** `CLAUDE.md`, commandes de développement/test, variables d'environnement et secrets, MCP par projet, informations et chemin de travail.

### 03 — Workspace Claude Code

- **Interaction :** démarrer/reprendre une session, saisir des instructions, recevoir une sortie en direct, arrêter une exécution, traiter les questions et demandes de permission selon les capacités officielles réellement disponibles.
- **Contexte :** explorateur de fichiers, consultation du code, terminal, logs, sorties de build/tests, état des processus et des changements.
- **Git intégré :** diff lisible, fichiers modifiés, historique, commits, push, branches et création/suivi de pull requests. Toutes les actions doivent avoir un véritable effet vérifiable.

### 04 — Sessions

- **Cycle de vie :** création, reprise, renommage, arrêt, archivage, statut et conservation du contexte lorsque la technologie le permet.
- **Isolation :** sessions parallèles et worktrees distincts ; protection contre l'édition simultanée conflictuelle des mêmes fichiers ; quotas CPU/RAM et limites de concurrence.
- **Historique et résilience :** liste filtrable par projet/date/état, affichage des erreurs, reconnexion du navigateur et récupération raisonnable après interruption ou redémarrage.

### 05 — Intégrations

- **GitHub :** connexion autorisée, accès limité aux dépôts, lecture/écriture Git et PR, état de synchronisation et erreurs explicites.
- **MCP :** liste, configuration, activation par projet, diagnostic, état de connexion et reconnexion des serveurs autorisés.
- **Services prévus :** Figma et GitHub ; Coolify pour les informations de développement et les accès réellement permis, sans transformer Nuera Dev en outil de production autonome.

### 06 — Paramètres et administration

- **Compte/sécurité :** authentification forte, expiration et révocation des sessions web, journal succinct des actions sensibles.
- **Claude Code :** statut de la connexion officielle, paramètres et modes réellement exposés, informations d'usage disponibles sans inventer d'API ou de métrique.
- **Serveur :** santé des services, erreurs, logs utiles, maintenance et redémarrage contrôlé des processus, informations de disponibilité.

## 7. Parcours transversaux obligatoires

Implémente ces parcours **de bout en bout**, pas comme des écrans indépendants :

1. **GitHub → sélection dépôt → clone sur le VPS → projet visible → ouverture du Workspace.**
2. **Projet → branche/worktree → session Claude → instruction → suivi en direct → autorisation/erreur → résultat.**
3. **Fichiers modifiés → diff → vérifications → commit cohérent → push → pull request GitHub.**
4. **Navigateur fermé → session conservée → retour depuis mobile → état et conversation récupérés lorsque possible.**
5. **Configuration MCP/secret → connexion réelle ou « connexion requise » → diagnostic explicite**, sans affichage mensonger.

Chaque parcours doit survivre aux états vides, doublons, erreurs réseau, problèmes d'autorisation et redémarrages pertinents. N'utilise pas de données métier codées en dur ni de mocks permanents : les fixtures sont réservées aux tests. Le frontend doit toujours être raccordé à la logique serveur et à une persistance réelle.

## 8. Exécution autonome, agents, commits et apprentissage continu

**Tu disposes de la liberté de choisir l'ordre et le découpage des chantiers.** Si ton environnement permet des sous-agents, utilise-les sur des lots véritablement indépendants (socle/DB, UI Figma, Git, sessions, sécurité, tests), après définition des contrats communs. Évite toute édition concurrente des mêmes fichiers, migrations ou composants partagés. Chaque lot doit livrer du **code intégré et vérifié**, pas une simple recommandation.

### Commits propres et réguliers

- **Committe après chaque étape cohérente terminée et vérifiée**, sans attendre la fin du projet : socle, fonctionnalité, intégration, correction ou documentation nécessaire.
- Inspecte le diff et l'index avant chaque commit. Exclue secrets, fichiers de build, artefacts inutiles et modifications sans rapport.
- Utilise les conventions de commits du dépôt ; à défaut, messages conventionnels sobres : `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- **Ne mentionne jamais le développement par IA, Claude, un agent ou un outil de génération dans les messages de commit, descriptions de PR et notes de livraison.** Aucun « Generated with », aucune signature de génération, aucun trailer `Co-authored-by` / `Co-Authored-By` ni attribution automatique équivalente. Cette règle d'attribution n'interdit pas de documenter **Claude Code en tant que fonctionnalité du produit** ni le fichier `CLAUDE.md`.
- Utilise une identité Git déjà configurée et autorisée ; n'invente aucun auteur. Les commits ne donnent pas carte blanche pour pousser, fusionner ou déployer dans un environnement tiers sans les droits correspondants.

### `CLAUDE.md` : mémoire vivante du projet

- **Crée le fichier racine dès l'initialisation**, avec architecture, conventions, commandes fiables, règles de sécurité, parcours et mode de travail.
- **Mets-le à jour au fil du développement** après toute décision structurante, pratique confirmée, bug résolu ou piège rencontré : contexte, cause vérifiée, solution durable, commande ou fichier de référence.
- Ne transforme pas des hypothèses en règles ; vérifie d'abord les corrections. Supprime les doublons et les consignes obsolètes ; ne stocke aucun secret ni donnée sensible.
- Fais relire les consignes applicables à chaque sous-agent et après les reprises de contexte. Conserve le suivi des tâches dans un fichier distinct, plus court et constamment actualisé.

### Rythme et qualité

- Alterne **implémentation → tests ciblés → correction → commit** ; intègre les lots dès qu'ils sont prêts.
- Utilise les outils, skills et MCP pertinents sans audits interminables ni lectures redondantes.
- Exécute lint, typecheck, tests unitaires pertinents, tests API et tests de parcours critiques ; termine par une validation globale et la correction des régressions.
- Poursuis automatiquement au-delà du premier écran ou du premier jalon. **Aucune validation utilisateur n'est nécessaire pour un choix d'implémentation réversible et raisonnable** ; un secret absent, un accès refusé ou une autorisation externe obligatoire restent des blocages explicites à ne jamais contourner.

## 9. Déploiement et exploitation préparés

**Le déploiement cible est le VPS-3 via l'instance Coolify déjà hébergée sur le VPS-1.** Prépare une configuration de build/déploiement compatible (Dockerfile/Compose seulement si nécessaire), healthchecks, variables d'environnement documentées et stockage persistant.

- Prévois les répertoires persistants des clones/worktrees, les données applicatives et les journaux nécessaires. **Un redéploiement du conteneur Next.js ne doit jamais supprimer ces données.**
- PostgreSQL doit être **prêt à être raccordé** à un service hébergé sur le VPS, distinct et non exposé publiquement ; prépare migrations, configuration et procédure de sauvegarde/restauration. Le propriétaire renseignera les accès réels lors de la mise en service. Vérifie tout le développement sur une instance PostgreSQL locale reproductible.
- Le service d'exécution doit être isolé et persistant, avec utilisateur système non-root, permissions minimales, communication privée avec le backend et contrôles stricts des chemins, commandes et ressources. N'expose jamais directement un shell ou le port interne de l'exécuteur sur Internet.
- Prévois `dev.nuera.studio`, HTTPS, authentification renforcée, cookies sécurisés, protections CSRF, limitation des abus, secret management et journal des actions sensibles.
- Ne déploie pas arbitrairement sur les serveurs existants et ne modifie pas leur configuration sans accès et autorisation adaptés. **L'absence d'accès au VPS ne doit pas empêcher de livrer une application locale complète et une configuration prête à déployer** ; ne prétends pas avoir testé la production si ce n'est pas le cas.

## 10. Définition de terminé

Ne t'arrête **ni après le scaffolding, ni après les premières pages, ni après un frontend visuellement convaincant**. La mission est terminée lorsque :

- [ ] Le dépôt vide a été entièrement initialisé, avec une structure Next.js/TypeScript propre, scripts, configuration, `.gitignore`, `.env.example`, `README` et `CLAUDE.md`.
- [ ] **Toutes les maquettes desktop et mobile** de Nuera Dev sont reproduites fidèlement à partir de Figma ; états et interactions manquants sont ajoutés en cohérence avec le design system.
- [ ] Les **6 domaines fonctionnels** et leurs parcours essentiels sont utilisables, sans boutons morts ni écrans purement décoratifs.
- [ ] Frontend, backend, opérations Git et données persistées sont **réellement reliés**. Les parcours fonctionnent avec une base PostgreSQL locale, des migrations et aucun faux état « connecté ».
- [ ] Les sessions longues, worktrees, logs, erreurs et actions sensibles sont traités correctement ; l'intégration Claude respecte les capacités et conditions officielles, et toute limitation d'abonnement non résolue est déclarée honnêtement.
- [ ] L'authentification, la séparation des privilèges, les permissions serveur, les secrets et les principaux cas d'erreur sont vérifiés.
- [ ] Les tests adaptés passent, les scénarios réels ont été exécutés, les régressions corrigées et les commits sont cohérents, propres et réguliers.
- [ ] `CLAUDE.md` contient les pratiques confirmées et les erreurs à éviter ; le suivi persistant reflète fidèlement l'avancement final.
- [ ] Le projet peut être lancé localement et dispose d'une **configuration de déploiement Coolify/VPS-3 prête**, avec les seules connexions externes réelles à effectuer par le propriétaire clairement identifiées.

**Livraison finale :** un compte rendu **bref, factuel et précis** des fonctionnalités effectivement opérationnelles, des vérifications réalisées, des limites externes vérifiées et des seules actions indispensables que le propriétaire doit accomplir. Ne présente jamais un raccordement non testé comme terminé.

**Instruction finale :** prends en charge Nuera Dev depuis son dépôt vide, découvre Figma, initialise, développe, raccorde, teste, améliore et commite continuellement. **Agis jusqu'à livrer le produit complet, fidèle aux maquettes et techniquement solide.**
