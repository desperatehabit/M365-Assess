from gen import graph_props
U = '/beta/admin/forms/settings'
SC = ['OrgSettings-Forms.ReadWrite.All']
F = {
 'FORMS-CONFIG-001': ('isExternalSendFormEnabled', False, 'People outside the organization can no longer respond to forms.'),
 'FORMS-CONFIG-002': ('isExternalShareCollaborationEnabled', False, 'People outside the organization can no longer co-author forms.'),
 'FORMS-CONFIG-003': ('isExternalShareResultEnabled', False, 'People outside the organization can no longer see result summaries.'),
 'FORMS-CONFIG-004': ('isPhishingScanEnabled', True, 'Forms scans for phishing questions (internal phishing protection).'),
 'FORMS-CONFIG-005': ('isRecordIdentityByDefaultEnabled', True, 'New forms record respondent names by default.'),
 'FORMS-CONFIG-006': ('isBingImageVideoSearchEnabled', False, 'Form authors can no longer insert Bing images or YouTube videos.'),
}
for cid, (prop, val, eff) in F.items():
    graph_props(cid, uri=U, body={prop: val}, scopes=SC, target='Microsoft Forms org settings',
                desc=f'Sets {prop} on the Microsoft Forms org settings (Graph beta admin/forms/settings).\n{eff}',
                notes='Uses a Microsoft Graph beta endpoint; behavior can change without notice.')
print(len(F))
